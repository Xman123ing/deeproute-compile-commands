import * as vscode from 'vscode';
import { DeepRouteCompileCommands } from './deepRouteCompileCommands';
import { OutputManager } from './outputManager';
import { CommandTreeProvider, CommandConfig } from './commandTreeProvider';

let deepRouteCompileCommands: DeepRouteCompileCommands | undefined;
let outputManager: OutputManager | undefined;
let treeProvider: CommandTreeProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Cursor DeepRoute Compile Commands activated');

    // Initialize output manager
    outputManager = new OutputManager();
    
    // Initialize DeepRoute Compile Commands
    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot) {
        deepRouteCompileCommands = new DeepRouteCompileCommands(workspaceRoot, outputManager);
    }

    // Initialize and register TreeView
    treeProvider = new CommandTreeProvider(context);
    const treeView = vscode.window.createTreeView('deeprouteCommandsList', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    // Register command: Execute predefined command (Command Palette)
    const executeCommand = vscode.commands.registerCommand(
        'deeproute-compile-commands.executeCommand',
        async () => {
            if (!deepRouteCompileCommands) {
                vscode.window.showErrorMessage('Workspace root not found');
                return;
            }

            const config = vscode.workspace.getConfiguration('deeproute-compile-commands');
            const predefinedCommands = config.get<(string | CommandConfig)[]>('predefinedCommands', []);

            if (predefinedCommands.length === 0) {
                vscode.window.showInformationMessage('No predefined commands configured. Please add them in settings');
                return;
            }

            // Convert to QuickPickItem
            const items = predefinedCommands.map(cmd => {
                if (typeof cmd === 'string') {
                    return {
                        label: cmd,
                        description: '',
                        command: cmd,
                        cwd: undefined
                    };
                } else {
                    // Use alias if available
                    const displayName = cmd.alias || cmd.command;
                    return {
                        label: displayName,
                        description: cmd.cwd || '',
                        detail: cmd.alias ? `Actual command: ${cmd.command}` : undefined,  // Show actual command if alias exists
                        command: cmd.command,
                        cwd: cmd.cwd
                    };
                }
            });

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select command to execute'
            });

            if (selected) {
                await executeCommandInternal(selected.command, selected.cwd);
            }
        }
    );

    // Register command: Execute custom command
    const executeCustomCommand = vscode.commands.registerCommand(
        'deeproute-compile-commands.executeCustomCommand',
        async () => {
            if (!deepRouteCompileCommands) {
                vscode.window.showErrorMessage('Workspace root not found');
                return;
            }

            const command = await vscode.window.showInputBox({
                prompt: 'Enter command to execute',
                placeHolder: 'e.g.: npm install',
                validateInput: (value) => {
                    return value.trim() ? null : 'Command cannot be empty';
                }
            });

            if (!command) {
                return;
            }

            // Ask for execution path
            const config = vscode.workspace.getConfiguration('deeproute-compile-commands');
            const dockerContainer = config.get<string>('dockerContainerName', '');
            
            let cwdPrompt: string;
            if (dockerContainer) {
                cwdPrompt = 'Enter execution directory (relative to /sandbox in container, leave empty for /sandbox)';
            } else {
                const workspaceRoot = getWorkspaceRoot();
                cwdPrompt = workspaceRoot 
                    ? `Enter execution directory (relative path, will be joined to ${workspaceRoot}, leave empty for workspace root)`
                    : 'Enter execution directory (relative to workspace root, leave empty for workspace root)';
            }
            
            const cwd = await vscode.window.showInputBox({
                prompt: cwdPrompt,
                placeHolder: dockerContainer ? 'e.g.: blc or ./blc or leave empty' : 'e.g.: build or ./build or leave empty',
                value: ''
            });

            // cwd is undefined when user cancels, empty string when left blank
            if (cwd === undefined) {
                return;
            }

            await executeCommandInternal(command, cwd?.trim() || undefined);
        }
    );

    // Register command: Execute command from TreeView
    const executeFromTree = vscode.commands.registerCommand(
        'deeproute-compile-commands.executeFromTree',
        async (commandOrTreeItem: string | any, cwd?: string) => {
            // When called from context menu, first param is TreeItem object
            // When called from node click, params are from command.arguments definition
            let actualCommand: string | undefined;
            let actualCwd: string | undefined;
            
            if (typeof commandOrTreeItem === 'string') {
                // When directly clicking node
                actualCommand = commandOrTreeItem;
                actualCwd = cwd;
            } else if (commandOrTreeItem && commandOrTreeItem.commandText) {
                // When called from context menu
                actualCommand = commandOrTreeItem.commandText;
                actualCwd = commandOrTreeItem.cwd;
            }
            
            if (actualCommand) {
                await executeCommandInternal(actualCommand, actualCwd);
            }
        }
    );

    // Register command: Stop current command
    const stopCommand = vscode.commands.registerCommand(
        'deeproute-compile-commands.stopCommand',
        () => {
            if (deepRouteCompileCommands) {
                deepRouteCompileCommands.stop();
            }
        }
    );

    // Register command: Clear output
    const clearOutput = vscode.commands.registerCommand(
        'deeproute-compile-commands.clearOutput',
        () => {
            if (outputManager) {
                outputManager.clear();
            }
        }
    );

    // Register command: Refresh command list
    const refreshCommands = vscode.commands.registerCommand(
        'deeproute-compile-commands.refreshCommands',
        () => {
            if (treeProvider) {
                treeProvider.refresh();
                vscode.window.showInformationMessage('Command list refreshed');
            }
        }
    );

    // Register command: Clear history
    const clearHistory = vscode.commands.registerCommand(
        'deeproute-compile-commands.clearHistory',
        () => {
            if (treeProvider) {
                treeProvider.clearHistory();
                vscode.window.showInformationMessage('History cleared');
            }
        }
    );

    // Register command: Add predefined command
    const addCommand = vscode.commands.registerCommand(
        'deeproute-compile-commands.addCommand',
        async () => {
            const command = await vscode.window.showInputBox({
                prompt: 'Enter command to add',
                placeHolder: 'e.g.: npm run dev',
                validateInput: (value) => {
                    return value.trim() ? null : 'Command cannot be empty';
                }
            });

            if (!command) {
                return;
            }

            const config = vscode.workspace.getConfiguration('deeproute-compile-commands');
            const dockerContainer = config.get<string>('dockerContainerName', '');
            
            let cwdPrompt: string;
            if (dockerContainer) {
                cwdPrompt = 'Enter execution directory (relative to /sandbox in container, leave empty for /sandbox)';
            } else {
                const workspaceRoot = getWorkspaceRoot();
                cwdPrompt = workspaceRoot 
                    ? `Enter execution directory (relative path, will be joined to ${workspaceRoot}, leave empty for workspace root)`
                    : 'Enter execution directory (relative to workspace root, leave empty for workspace root)';
            }
            
            const cwd = await vscode.window.showInputBox({
                prompt: cwdPrompt,
                placeHolder: dockerContainer ? 'e.g.: blc or ./blc or leave empty' : 'e.g.: build or ./build or leave empty',
                value: ''
            });

            // Ask if user wants to set alias
            const alias = await vscode.window.showInputBox({
                prompt: 'Enter command alias (optional, used for display in list)',
                placeHolder: 'e.g.: 🔨 Build Project or leave empty to use command itself',
                value: ''
            });

            const commands = config.get<(string | CommandConfig)[]>('predefinedCommands', []);
            
            // Check if command already exists
            const exists = commands.some(cmd => {
                const cmdText = typeof cmd === 'string' ? cmd : cmd.command;
                return cmdText === command;
            });
            
            if (exists) {
                vscode.window.showWarningMessage('Command already exists');
                return;
            }

            // Add new command
            const newCommand: CommandConfig = {
                command: command,
                cwd: cwd?.trim() || undefined,
                alias: alias?.trim() || undefined
            };
            commands.push(newCommand);
            await config.update('predefinedCommands', commands, vscode.ConfigurationTarget.Global);
            
            const displayName = newCommand.alias || command;
            const msg = newCommand.cwd 
                ? `Command added: ${displayName} (directory: ${newCommand.cwd})`
                : `Command added: ${displayName}`;
            vscode.window.showInformationMessage(msg);
            
            if (treeProvider) {
                treeProvider.refresh();
            }
        }
    );

    // Register command: Remove command
    const removeCommand = vscode.commands.registerCommand(
        'deeproute-compile-commands.removeCommand',
        async (treeItem: any) => {
            if (!treeItem || !treeItem.commandText) {
                return;
            }

            const command = treeItem.commandText;
            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to remove command "${command}"?`,
                'Remove',
                'Cancel'
            );

            if (confirm === 'Remove') {
                const config = vscode.workspace.getConfiguration('deeproute-compile-commands');
                const commands = config.get<(string | CommandConfig)[]>('predefinedCommands', []);
                
                // Find and remove command
                const newCommands = commands.filter(cmd => {
                    const cmdText = typeof cmd === 'string' ? cmd : cmd.command;
                    return cmdText !== command;
                });
                
                if (newCommands.length < commands.length) {
                    await config.update('predefinedCommands', newCommands, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`Command removed: ${command}`);
                    
                    if (treeProvider) {
                        treeProvider.refresh();
                    }
                }
            }
        }
    );

    // Register command: Edit command alias
    const editCommandAlias = vscode.commands.registerCommand(
        'deeproute-compile-commands.editCommandAlias',
        async (treeItem: any) => {
            if (!treeItem || !treeItem.commandText) {
                return;
            }

            const command = treeItem.commandText;
            const config = vscode.workspace.getConfiguration('deeproute-compile-commands');
            const commands = config.get<(string | CommandConfig)[]>('predefinedCommands', []);
            
            // Find current command
            const currentCommandIndex = commands.findIndex(cmd => {
                const cmdText = typeof cmd === 'string' ? cmd : cmd.command;
                return cmdText === command;
            });

            if (currentCommandIndex === -1) {
                vscode.window.showErrorMessage('Command not found');
                return;
            }

            const currentCommand = commands[currentCommandIndex];
            const currentAlias = typeof currentCommand === 'string' ? '' : (currentCommand.alias || '');

            // Input new alias
            const newAlias = await vscode.window.showInputBox({
                prompt: 'Enter new command alias (leave empty to not use alias)',
                placeHolder: 'e.g.: 🔨 Build Project',
                value: currentAlias
            });

            // User cancelled
            if (newAlias === undefined) {
                return;
            }

            // Update command configuration
            if (typeof currentCommand === 'string') {
                // If string format, convert to object format
                commands[currentCommandIndex] = {
                    command: currentCommand,
                    alias: newAlias.trim() || undefined
                };
            } else {
                // If object format, update alias
                commands[currentCommandIndex] = {
                    ...currentCommand,
                    alias: newAlias.trim() || undefined
                };
            }

            await config.update('predefinedCommands', commands, vscode.ConfigurationTarget.Global);
            
            const displayName = newAlias.trim() || command;
            vscode.window.showInformationMessage(`✅ Alias updated: ${displayName}`);
            
            if (treeProvider) {
                treeProvider.refresh();
            }
        }
    );

    // Register command: Configure Docker container name
    const configureDocker = vscode.commands.registerCommand(
        'deeproute-compile-commands.configureDocker',
        async () => {
            const config = vscode.workspace.getConfiguration('deeproute-compile-commands');
            
            // Get currently configured container name
            const currentContainer = config.get<string>('dockerContainerName', '');
            
            // Input Docker container name
            const containerName = await vscode.window.showInputBox({
                prompt: 'Enter Docker container name',
                placeHolder: 'e.g./default: deeproute-dev-x86-2004',
                value: currentContainer,
                validateInput: (value) => {
                    // Allow empty (to clear configuration)
                    return null;
                }
            });

            // If user cancelled input, return
            if (containerName === undefined) {
                return;
            }

            // Save configuration (allow empty string to disable Docker mode)
            const trimmedName = containerName.trim();
            await config.update('dockerContainerName', trimmedName, vscode.ConfigurationTarget.Global);

            if (trimmedName) {
                vscode.window.showInformationMessage(
                    `✅ Docker mode configured\n🐳 Container name: ${trimmedName}\n\nAll commands will execute in container's /sandbox directory`
                );
            } else {
                vscode.window.showInformationMessage(
                    `✅ Docker mode disabled\n\nAll commands will execute locally`
                );
            }
        }
    );

    context.subscriptions.push(
        treeView,
        executeCommand,
        executeCustomCommand,
        executeFromTree,
        stopCommand,
        clearOutput,
        refreshCommands,
        clearHistory,
        addCommand,
        removeCommand,
        editCommandAlias,
        configureDocker
    );
}

/**
 * Internal method to execute command
 */
async function executeCommandInternal(command: string, cwd?: string): Promise<void> {
    if (!deepRouteCompileCommands) {
        vscode.window.showErrorMessage('Workspace root not found');
        return;
    }

    // Add to history
    if (treeProvider) {
        treeProvider.addToHistory(command, cwd);
    }

    // Execute command
    await deepRouteCompileCommands.execute(command, cwd);
}

export function deactivate() {
    if (deepRouteCompileCommands) {
        deepRouteCompileCommands.dispose();
    }
    if (outputManager) {
        outputManager.dispose();
    }
}

/**
 * Get workspace root directory
 * Supports local workspace and SSH remote workspace
 */
function getWorkspaceRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }

    // Get first workspace folder URI
    const workspaceUri = workspaceFolders[0].uri;
    
    // For remote SSH, URI scheme will be 'vscode-remote'
    // path property will contain remote path
    return workspaceUri.fsPath;
}
