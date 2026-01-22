import * as vscode from 'vscode';

/**
 * 命令配置接口
 */
export interface CommandConfig {
    command: string;
    cwd?: string;
    alias?: string;  // 命令别名，用于显示
}

/**
 * 命令历史记录项接口
 */
export interface HistoryItem {
    command: string;
    cwd?: string;
    timestamp?: number;  // 执行时间戳（可选）
}

/**
 * 命令树节点类型
 */
export enum CommandNodeType {
    PREDEFINED_COMMANDS = 'predefined',
    CUSTOM_COMMAND = 'custom',
    COMMAND_ITEM = 'command',
    HISTORY = 'history',
    HISTORY_ITEM = 'history_item'
}

/**
 * 命令树节点
 */
export class CommandTreeItem extends vscode.TreeItem {
    // 保存命令文本，用于执行
    public readonly commandText?: string;
    // 保存命令执行目录
    public readonly cwd?: string;

    constructor(
        public readonly label: string,
        public readonly nodeType: CommandNodeType,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
        commandText?: string,
        cwd?: string
    ) {
        super(label, collapsibleState);
        
        // Save command text and working directory
        this.commandText = commandText;
        this.cwd = cwd;

        // Set different icons and contexts based on node type (Apple style design)
        // Root nodes use UPPERCASE labels for better visual hierarchy
        switch (nodeType) {
            case CommandNodeType.PREDEFINED_COMMANDS:
                // Use layers icon - represents predefined command collection, similar to Shortcuts.app
                this.iconPath = new vscode.ThemeIcon('layers', new vscode.ThemeColor('charts.blue'));
                this.contextValue = 'predefinedGroup';
                this.tooltip = 'Predefined Commands';
                // Don't set description, use view/title menu in package.json for + button
                break;
            
            case CommandNodeType.HISTORY:
                // Use timeline-view-icon - modern timeline icon, similar to macOS history
                this.iconPath = new vscode.ThemeIcon('timeline-view-icon', new vscode.ThemeColor('charts.purple'));
                this.contextValue = 'historyGroup';
                this.tooltip = 'Command History';
                break;
            
            case CommandNodeType.CUSTOM_COMMAND:
                // Use symbol-key - represents typing command, similar to Terminal.app prompt
                this.iconPath = new vscode.ThemeIcon('symbol-key', new vscode.ThemeColor('charts.green'));
                this.contextValue = 'customCommand';
                this.tooltip = 'Click to enter custom command';
                // Set click behavior
                this.command = {
                    command: 'deeproute-compile-commands.executeCustomCommand',
                    title: 'Execute Custom Command'
                };
                break;
            
            case CommandNodeType.COMMAND_ITEM:
                // Use run - precise execution semantics, similar to Automator.app action icon
                this.iconPath = new vscode.ThemeIcon('run', new vscode.ThemeColor('terminal.ansiBlue'));
                this.contextValue = 'commandItem';
                this.tooltip = `Execute: ${this.commandText}${this.cwd ? '\nDirectory: ' + this.cwd : ''}`;
                // Set click behavior
                this.command = {
                    command: 'deeproute-compile-commands.executeFromTree',
                    title: 'Execute Command',
                    arguments: [this.commandText, this.cwd]
                };
                break;
            
            case CommandNodeType.HISTORY_ITEM:
                // Use record - represents recorded command, similar to system log entry
                this.iconPath = new vscode.ThemeIcon('record', new vscode.ThemeColor('charts.gray'));
                this.contextValue = 'historyItem';
                this.tooltip = `Execute: ${this.commandText}${this.cwd ? '\nDirectory: ' + this.cwd : ''}`;
                // Set click behavior
                this.command = {
                    command: 'deeproute-compile-commands.executeFromTree',
                    title: 'Execute Command',
                    arguments: [this.commandText, this.cwd]
                };
                break;
        }
    }
}

/**
 * Command Tree Data Provider
 */
export class CommandTreeProvider implements vscode.TreeDataProvider<CommandTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<CommandTreeItem | undefined | null | void> = new vscode.EventEmitter<CommandTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<CommandTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private commandHistory: HistoryItem[] = [];
    private maxHistorySize = 10;
    private context: vscode.ExtensionContext;
    private readonly HISTORY_STORAGE_KEY = 'deeproute-compile-commands.commandHistory';

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        
        // Load history from persistent storage
        this.loadHistory();
        
        // Listen to configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('deeproute-compile-commands.predefinedCommands')) {
                this.refresh();
            }
        });
    }
    
    /**
     * Load history from persistent storage
     * Compatible with old format (string[]) and new format (HistoryItem[])
     */
    private loadHistory(): void {
        const savedHistory = this.context.globalState.get<any[]>(this.HISTORY_STORAGE_KEY);
        if (savedHistory && Array.isArray(savedHistory)) {
            // Convert old format to new format
            this.commandHistory = savedHistory.map(item => {
                if (typeof item === 'string') {
                    // Old format: string
                    return { command: item };
                } else {
                    // New format: object
                    return item as HistoryItem;
                }
            });
        }
    }
    
    /**
     * Save history to persistent storage
     */
    private saveHistory(): void {
        this.context.globalState.update(this.HISTORY_STORAGE_KEY, this.commandHistory);
    }

    /**
     * Refresh tree view
     * Pass undefined to ensure full tree refresh, avoiding indentation issues from inconsistent states
     */
    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Get tree item
     */
    getTreeItem(element: CommandTreeItem): vscode.TreeItem {
        return element;
    }

    /**
     * Get child nodes
     */
    getChildren(element?: CommandTreeItem): Thenable<CommandTreeItem[]> {
        if (!element) {
            // Root nodes - three sibling nodes: Predefined Commands, Execute Custom Command, Command History
            // Important: All root nodes must use same collapsibleState type (all Collapsed or all Expanded)
            // Mixing None with Collapsed/Expanded causes VS Code TreeView rendering hierarchy errors
            // Use UPPERCASE for better visibility and hierarchy (avoid adding symbols that conflict with VS Code's built-in UI)
            const rootItems = [
                new CommandTreeItem(
                    'PREDEFINED COMMANDS',
                    CommandNodeType.PREDEFINED_COMMANDS,
                    vscode.TreeItemCollapsibleState.Expanded
                ),
                new CommandTreeItem(
                    'EXECUTE CUSTOM COMMAND',
                    CommandNodeType.CUSTOM_COMMAND,
                    vscode.TreeItemCollapsibleState.Collapsed  // Changed to Collapsed, avoid None causing indentation
                ),
                new CommandTreeItem(
                    'COMMAND HISTORY',
                    CommandNodeType.HISTORY,
                    vscode.TreeItemCollapsibleState.Collapsed
                )
            ];
            
            return Promise.resolve(rootItems);
        }

        // Child nodes
        if (element.nodeType === CommandNodeType.PREDEFINED_COMMANDS) {
            return this.getPredefinedCommands();
        } else if (element.nodeType === CommandNodeType.HISTORY) {
            return this.getHistoryCommands();
        } else if (element.nodeType === CommandNodeType.CUSTOM_COMMAND) {
            // "Execute Custom Command" has no child nodes, return empty array
            return Promise.resolve([]);
        }

        return Promise.resolve([]);
    }

    /**
     * Get predefined commands list
     */
    private getPredefinedCommands(): Thenable<CommandTreeItem[]> {
        const config = vscode.workspace.getConfiguration('deeproute-compile-commands');
        const commands = config.get<(string | CommandConfig)[]>('predefinedCommands', []);

        if (commands.length === 0) {
            return Promise.resolve([
                new CommandTreeItem(
                    'No predefined commands',
                    CommandNodeType.COMMAND_ITEM,
                    vscode.TreeItemCollapsibleState.None
                )
            ]);
        }

        const items = commands.map(cmd => {
            // Compatible with old format (string) and new format (object)
            if (typeof cmd === 'string') {
                return new CommandTreeItem(
                    cmd,
                    CommandNodeType.COMMAND_ITEM,
                    vscode.TreeItemCollapsibleState.None,
                    cmd,
                    undefined
                );
            } else {
                // Use alias if available, otherwise use command itself
                const displayName = cmd.alias || cmd.command;
                const item = new CommandTreeItem(
                    displayName,
                    CommandNodeType.COMMAND_ITEM,
                    vscode.TreeItemCollapsibleState.None,
                    cmd.command,
                    cmd.cwd
                );
                // Path info only shown in tooltip (set by CommandTreeItem constructor)
                return item;
            }
        });

        return Promise.resolve(items);
    }

    /**
     * Get history commands list
     */
    private getHistoryCommands(): Thenable<CommandTreeItem[]> {
        if (this.commandHistory.length === 0) {
            return Promise.resolve([
                new CommandTreeItem(
                    'No execution history',
                    CommandNodeType.HISTORY_ITEM,
                    vscode.TreeItemCollapsibleState.None
                )
            ]);
        }

        // Newest first
        return Promise.resolve(
            [...this.commandHistory].reverse().map(historyItem => {
                const item = new CommandTreeItem(
                    historyItem.command,
                    CommandNodeType.HISTORY_ITEM,
                    vscode.TreeItemCollapsibleState.None,
                    historyItem.command,
                    historyItem.cwd
                );
                
                // Explicitly set tooltip to ensure command and path are shown
                // Path info only shown in tooltip
                if (historyItem.cwd) {
                    item.tooltip = `Execute: ${historyItem.command}\nDirectory: ${historyItem.cwd}`;
                } else {
                    item.tooltip = `Execute: ${historyItem.command}`;
                }
                
                return item;
            })
        );
    }

    /**
     * Add command to history
     */
    addToHistory(command: string, cwd?: string): void {
        // Remove if same command and path combination already exists
        const index = this.commandHistory.findIndex(
            item => item.command === command && item.cwd === cwd
        );
        if (index > -1) {
            this.commandHistory.splice(index, 1);
        }

        // Add to end
        const historyItem: HistoryItem = {
            command,
            cwd,
            timestamp: Date.now()
        };
        this.commandHistory.push(historyItem);

        // Limit history size
        if (this.commandHistory.length > this.maxHistorySize) {
            this.commandHistory.shift();
        }

        // Save persistently
        this.saveHistory();
        
        this.refresh();
    }

    /**
     * Clear history
     */
    clearHistory(): void {
        this.commandHistory = [];
        
        // Save persistently
        this.saveHistory();
        
        this.refresh();
    }

    /**
     * Get history
     */
    getHistory(): HistoryItem[] {
        return [...this.commandHistory];
    }
}
