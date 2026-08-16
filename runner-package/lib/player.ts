import { Bot } from 'mineflayer';
import { ItemWrapper, GuiWrapper, createPlayerExtensions, Window, LiveGuiHandle } from './wrappers.js';
import { ServerWrapper } from './server.js';
import type { Session } from './session.js';
import type { BotConnectionOptions } from './environment.js';
import type { Account } from './account.js';
import { poll } from './utils.js';
import { randomUUID } from 'node:crypto';
import pc from 'picocolors';

export class PlayerWrapper {
    bot: Bot;
    readonly session: Session;

    get inventory() {
        return this.bot.inventory;
    }

    get username() {
        return this.bot.username;
    }

    /**
     * @deprecated Use `player.gui({ title })` instead.
     */
    waitForGui!: (guiMatcher: (gui: GuiWrapper) => boolean, options?: { timeout?: number }) => Promise<GuiWrapper>;

    /**
     * @deprecated Use `gui.locator(predicate)` with expectations instead.
     */
    waitForGuiItem!: (itemMatcher: (item: ItemWrapper) => boolean, options?: { timeout?: number, pollingRate?: number }) => Promise<ItemWrapper>;

    /**
     * @deprecated Use `gui.locator(predicate).click()` instead.
     */
    clickGuiItem!: (itemMatcher: (item: ItemWrapper) => boolean, options?: { timeout?: number, pollingRate?: number }) => Promise<void>;

    gui!: (options: { title: string | RegExp; timeout?: number }) => Promise<LiveGuiHandle>;
    private serverWrapper?: ServerWrapper;
    private _botOptions?: BotConnectionOptions;
    private _spawnPromise: Promise<void> | null = null;
    private _listenersBot: Bot | null = null;
    private _account?: Account;
    /** Labels describing server state this player is known to carry — set automatically by
     *  `makeOp`/`deOp`/`setGameMode`, and by hand via `mark`/`unmark` for anything else. Survives
     *  `rejoin()`: it describes server state, which a reconnect doesn't touch. Used by
     *  `PlayerRegistry` to match a reused player against a test's requirements; the core never
     *  parses or verifies a label's meaning. */
    private readonly _abilities = new Set<string>();

    constructor(bot: Bot, session: Session) {
        this.bot = bot;
        this.session = session;
        this._bindExtensions(bot);
    }

    private _bindExtensions(bot: Bot): void {
        const extensions = createPlayerExtensions(bot);
        this.waitForGui = extensions.waitForGui.bind(this);
        this.waitForGuiItem = extensions.waitForGuiItem.bind(this);
        this.clickGuiItem = extensions.clickGuiItem.bind(this);
        this.gui = extensions.gui.bind(this);
    }

    /** @internal */
    _captureSpawnPromise(timeout: number = 30000): void {
        const bot = this.bot;
        // NOTE: bot.username is undefined until the client actually connects
        // and completes the handshake, so we resolve it lazily inside handlers.
        const name = (): string => bot.username ?? this.username ?? 'bot';

        this._spawnPromise = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Bot ${name()} failed to spawn within ${timeout}ms`));
            }, timeout);

            const onSpawn = () => {
                cleanup();
                console.log(`${pc.cyan('[Bot]')} ${pc.dim(`${name()} spawned successfully`)}`);
                resolve();
            };

            const onError = (err: Error) => {
                cleanup();
                console.log(pc.red(`[Bot] ${name()} connection error: ${err.message}`));
                reject(err);
            };

            const onKicked = (reason: string) => {
                cleanup();
                console.log(pc.red(`[Bot] ${name()} kicked: ${reason}`));
                reject(new Error(`Bot ${name()} was kicked: ${reason}`));
            };

            const cleanup = () => {
                clearTimeout(timer);
                bot.removeListener('spawn', onSpawn);
                bot.removeListener('error', onError);
                bot.removeListener('kicked', onKicked);
            };

            bot.once('spawn', onSpawn);
            bot.once('error', onError);
            bot.once('kicked', onKicked);
        });

        this._spawnPromise.catch(() => {});
    }

    async join(options: { timeout?: number } = {}): Promise<void> {
        const { timeout = 30000 } = options;

        if (!this._spawnPromise) {
            this._captureSpawnPromise(timeout);
        }

        // Listeners go up before the first await: a login wall greets the bot as soon as it
        // enters the play state, and a prompt that arrives before the message buffer exists
        // is a prompt no authentication plugin can answer.
        this._registerPersistentListeners();

        if (this._account) {
            // Authentication has to happen while the server still holds the player: AuthMe and
            // friends keep an unauthenticated bot out of the world entirely, so waiting for the
            // spawn first would wait for something login is the precondition of.
            await Promise.race([this._spawnPromise, this._waitForLogin(timeout)]);
            await this.session.onPlayerCreate?.(this, { account: this._account, env: this.session.env });
        }

        await this._spawnPromise;
        this._spawnPromise = null;
    }

    /** Resolves once the client is in the play state, where chat works and the server's login
     *  prompt has been delivered. Never rejects on its own — it is raced against the spawn
     *  promise, which already fails on a kick, an error or a timeout. */
    private _waitForLogin(timeout: number): Promise<void> {
        if (this.bot.entity) return Promise.resolve();

        return new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.bot.removeListener('login', onLogin);
                resolve();
            }, timeout);

            const onLogin = (): void => {
                clearTimeout(timer);
                resolve();
            };

            this.bot.once('login', onLogin);
        });
    }

    /** @internal */
    _setAccount(account: Account): void {
        this._account = account;
    }

    /** The account this player connected with. Set for every player the runner creates
     *  (`createPlayer` always calls `_setAccount`); undefined only if constructed by hand. */
    get account(): Account | undefined {
        return this._account;
    }

    private _registerPersistentListeners(): void {
        if (this._listenersBot === this.bot) return;
        this._listenersBot = this.bot;

        const botUsername = this.username;
        const bot = this.bot;

        bot.on('message', (jsonMsg: unknown) => {
            const message = String(jsonMsg);
            console.log(pc.dim(`[Bot ${botUsername}] Received message: "${message}"`));
            this.session.messages.push(message);
        });

        bot.on('windowOpen', (window: unknown) => {
            if (process.env.PLUGWRIGHT_DEBUG !== '1') return;
            const win = window as { title?: string; type?: string | number; slots?: unknown[] };
            console.log(pc.gray(`[DEBUG] [Bot ${botUsername}] Global windowOpen event - Title: "${win.title}", Type: ${win.type}, SlotCount: ${win.slots?.length}`));
        });

        bot.on('windowClose', (window: unknown) => {
            if (process.env.PLUGWRIGHT_DEBUG !== '1') return;
            const win = window as { title?: string };
            console.log(pc.gray(`[DEBUG] [Bot ${botUsername}] windowClose event - Window: ${win?.title || 'unknown'}`));
        });
    }

    setServerWrapper(server: ServerWrapper): void {
        this.serverWrapper = server;
    }

    /** Read-only snapshot of this player's ability labels. */
    get abilities(): ReadonlySet<string> {
        return this._abilities;
    }

    /** Records that this player carries `ability`. A statement, not a check — nothing here
     *  verifies it against real server state. */
    mark(ability: string): void {
        this._abilities.add(ability);
    }

    /** Removes `ability`. No-op if the player never carried it. */
    unmark(ability: string): void {
        this._abilities.delete(ability);
    }

    private markGameMode(mode: string): void {
        for (const ability of this._abilities) {
            if (ability.startsWith('gamemode:')) this._abilities.delete(ability);
        }
        this._abilities.add(`gamemode:${mode}`);
    }

    getCurrentGui(): GuiWrapper | null {
        let currentWindow = this.bot.currentWindow;
        return currentWindow ? new GuiWrapper(this.bot, currentWindow as Window) : null;
    }

    chat(message: string): void {
        console.log(`${pc.cyan('[Bot]')} ${pc.dim(`Chatting: ${message}`)}`);
        this.bot.chat(message);
    }

    getMessageBufferIndex(): number {
        return this.session.messages.length;
    }

    nextMessage(options: { timeout?: number } = {}): Promise<string> {
        const { timeout = 5000 } = options;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.bot.removeListener('message', handler);
                reject(new Error('Timeout: no message received'));
            }, timeout);

            const handler = (jsonMsg: unknown) => {
                clearTimeout(timer);
                this.bot.removeListener('message', handler);
                resolve(String(jsonMsg));
            };

            this.bot.on('message', handler);
        });
    }

    async makeOp(): Promise<void> {
        this.requireServer();
        const command = `minecraft:op ${this.username}`;

        // A console that answers (RCON) says whether the command worked; the confirmation is
        // never broadcast to the player, so there is nothing to wait for in the chat buffer.
        if (this.session.console?.output === 'responses') {
            const response = await this.serverWrapper!.executeAndWait(command);
            // "Made X a server operator" on success, "Nothing changed. The player already is
            // an operator" when it was already granted — both mean the player is op now.
            if (/operator/i.test(response)) {
                this.mark('op');
                return;
            }
            throw new Error(`Player ${this.username} was not opped: ${response.trim() || 'no response from the console'}`);
        }

        const messagesSince = this.session.messages.length;
        const consoleSince = this.session.consoleLog.length;
        this.serverWrapper!.execute(command);

        // "Made X a server operator" reaches the player's own chat. "Nothing changed. The
        // player already is an operator" — the case a reused, already-op player hits on a
        // second `makeOp()` — never does; it only ever shows up in the server's own log.
        await poll(
            () =>
                this.session.messages.slice(messagesSince).find(m => m.includes(`Made ${this.username} a server operator`)) ??
                this.session.consoleLog.slice(consoleSince).find(m => /operator/i.test(m)),
            { message: `Player ${this.username} was not opped` }
        );
        this.mark('op');
    }

    async deOp(): Promise<void> {
        await this.executeAndSync(`minecraft:deop ${this.username}`);
        this.unmark('op');
    }

    async setGameMode(mode: 'survival' | 'creative' | 'adventure' | 'spectator'): Promise<void> {
        if (this.bot.game.gameMode === mode) {
            this.markGameMode(mode);
            return;
        }
        this.requireServer();
        this.serverWrapper!.execute(`minecraft:gamemode ${mode} ${this.username}`);

        await poll(
            () => this.bot.game.gameMode === mode ? true : undefined,
            { message: `Game mode did not change to "${mode}"` }
        );
        this.markGameMode(mode);
    }

    async teleport(x: number, y: number, z: number): Promise<void> {
        this.requireServer();
        this.serverWrapper!.execute(`minecraft:tp ${this.username} ${x} ${y} ${z}`);

        await poll(
            () => {
                const pos = this.bot.entity.position;
                const close =
                    Math.abs(pos.x - x) < 1 &&
                    Math.abs(pos.y - y) < 1 &&
                    Math.abs(pos.z - z) < 1;
                return close ? true : undefined;
            },
            { message: `Teleport to ${x} ${y} ${z} timed out` }
        );
    }

    /** @internal */
    _setBotOptions(opts: BotConnectionOptions): void {
        this._botOptions = opts;
    }

    async rejoin(options: { timeout?: number } = {}): Promise<void> {
        if (!this._botOptions) {
            throw new Error('Cannot rejoin: bot connection options not set. Use wrapPlayer() to create players.');
        }

        const botUsername = this.username;
        const oldBot = this.bot;

        await this.session.disconnectBot(oldBot, botUsername);
        this.session.removeBot(oldBot);

        const newBot = this.session.createBot({
            ...this._botOptions,
            username: botUsername,
        });

        this.bot = newBot;
        this._listenersBot = null;
        this._bindExtensions(newBot);

        this._captureSpawnPromise(options.timeout || 30000);

        try {
            await this.join(options);
        } catch (err) {
            this.session.removeBot(this.bot);
            throw err;
        }
    }

    async giveItem(item: string, count: number = 1): Promise<void> {
        this.requireServer();
        this.serverWrapper!.execute(`minecraft:give ${this.username} ${item} ${count}`);

        await poll(
            () => {
                const total = this.bot.inventory.items()
                    .filter(i => i.name.includes(item))
                    .reduce((sum, i) => sum + i.count, 0);
                return total >= count ? true : undefined;
            },
            { message: `Expected ${count}x "${item}" in inventory` }
        );
    }

    private requireServer(): void {
        if (!this.serverWrapper) {
            throw new Error('ServerWrapper not set on PlayerWrapper');
        }
    }

    private async executeAndSync(cmd: string): Promise<void> {
        this.requireServer();

        // A console that answers has already finished the command by the time it replies. The
        // marker below exists for the stdio console, where output and command completion are
        // two unrelated streams.
        if (this.session.console?.output === 'responses') {
            await this.serverWrapper!.executeAndWait(cmd);
            return;
        }

        const syncId = `sync_${randomUUID().split('-')[0]}`;
        this.serverWrapper!.execute(cmd);
        this.serverWrapper!.execute(`minecraft:say ${syncId}`);

        await poll(
            () => this.session.messages.find(m => m.includes(syncId)),
            { message: `Server command sync timed out for: ${cmd}` }
        );
    }
}