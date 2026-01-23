import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { OutputManager } from './outputManager';

export class DeepRouteCompileCommands {
    private currentProcess: child_process.ChildProcess | undefined;
    private workspaceRoot: string;
    private outputManager: OutputManager;
    private workspaceRootValid: boolean = false;  // Whether workspace root is valid

    constructor(workspaceRoot: string, outputManager: OutputManager) {
        this.workspaceRoot = workspaceRoot;
        this.outputManager = outputManager;
        
        // Check workspace root on initialization
        this.workspaceRootValid = this.checkWorkspaceRoot();
    }

    /**
     * Execute command in Docker container (non-interactive)
     * @param containerName Docker container name
     * @param command Command to execute
     * @param cwd Working directory (relative to /sandbox in container)
     */
    private async executeInDocker(containerName: string, command: string, cwd?: string): Promise<void> {
        // Stop current process if any
        if (this.currentProcess) {
            const shouldStop = await vscode.window.showWarningMessage(
                'A command is currently running. Stop it?',
                'Stop and Execute New Command',
                'Cancel'
            );

            if (shouldStop !== 'Stop and Execute New Command') {
                return;
            }

            this.stop();
        }

        // Determine working directory in container
        // Container root is /sandbox, append cwd if specified
        let containerWorkDir = '/sandbox';
        if (cwd && cwd.trim()) {
            // Remove leading ./ or /
            const cleanCwd = cwd.trim().replace(/^\.?\//, '');
            containerWorkDir = `/sandbox/${cleanCwd}`;
        }

        // Show output
        this.outputManager.show();
        this.outputManager.appendLine(`\n========================================`);
        this.outputManager.appendLine(`Executing: ${command}`);
        this.outputManager.appendLine(`🐳 Docker Mode: Yes`);
        this.outputManager.appendLine(`Container: ${containerName}`);
        this.outputManager.appendLine(`📁 Working Dir: ${containerWorkDir}`);
        this.outputManager.appendLine(`Time: ${new Date().toLocaleString()}`);
        this.outputManager.appendLine(`========================================\n`);
        
        // Pre-check: Verify container status using docker inspect (one call to get all info)
        const inspectResult = child_process.spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', containerName], {
            cwd: this.workspaceRoot
        });

        // Check if docker command itself failed (Docker not running)
        if (inspectResult.error) {
            this.outputManager.appendLine(`❌ Docker is not accessible: ${inspectResult.error.message}`);
            this.outputManager.appendLine(`💡 Please ensure Docker Desktop/Engine is running.`);
            vscode.window.showErrorMessage(`Docker is not running. Please start Docker Desktop/Engine and try again.`);
            return;
        }

        // Check if container exists
        if (inspectResult.status !== 0) {
            const errorMsg = inspectResult.stderr.toString().trim();
            
            // Container does not exist
            if (errorMsg.includes('No such object') || errorMsg.includes('Error: No such container')) {
                this.outputManager.appendLine(`❌ Container '${containerName}' does not exist`);
                this.outputManager.appendLine(`\n💡 Available containers:`);
                
                // List available containers
                const listResult = child_process.spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}'], {
                    cwd: this.workspaceRoot
                });
                const availableContainers = listResult.stdout.toString().trim();
                if (availableContainers) {
                    this.outputManager.appendLine(availableContainers);
                } else {
                    this.outputManager.appendLine(`   (No containers found)`);
                }
                
                vscode.window.showErrorMessage(`Docker container '${containerName}' does not exist. Please check container name in settings.`);
                return;
            }
            
            // Other Docker errors
            this.outputManager.appendLine(`❌ Docker error: ${errorMsg}`);
            vscode.window.showErrorMessage(`Docker error: ${errorMsg}`);
            return;
        }

        // Parse container running status
        const isRunning = inspectResult.stdout.toString().trim() === 'true';
        
        if (!isRunning) {
            this.outputManager.appendLine(`⚠️  Container '${containerName}' is stopped`);
            this.outputManager.appendLine(`🚀 Starting container...`);
            
            const startResult = child_process.spawnSync('docker', ['start', containerName], {
                cwd: this.workspaceRoot
            });

            if (startResult.error || startResult.status !== 0) {
                const errorMsg = startResult.stderr?.toString().trim() || startResult.error?.message || 'Unknown error';
                this.outputManager.appendLine(`❌ Failed to start container: ${errorMsg}`);
                this.outputManager.appendLine(`\n💡 Possible reasons:`);
                this.outputManager.appendLine(`   - Container configuration error`);
                this.outputManager.appendLine(`   - Required resources not available`);
                this.outputManager.appendLine(`   - Check logs: docker logs ${containerName}`);
                vscode.window.showErrorMessage(`Docker container failed to start: ${errorMsg}`);
                return;
            }

            // Verify container started successfully
            const verifyResult = child_process.spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', containerName], {
                cwd: this.workspaceRoot
            });
            
            const nowRunning = verifyResult.status === 0 && verifyResult.stdout.toString().trim() === 'true';
            if (!nowRunning) {
                this.outputManager.appendLine(`❌ Container started but not running (may have crashed)`);
                this.outputManager.appendLine(`💡 Check container logs: docker logs ${containerName}`);
                vscode.window.showErrorMessage(`Container started but immediately stopped. Check Docker logs.`);
                return;
            }
            
            this.outputManager.appendLine(`✅ Container started and verified running\n`);
        }

        // Determine host working directory (for checking compile_commands.json)
        let hostWorkDir = this.workspaceRoot;
        if (cwd && cwd.trim()) {
            const cleanCwd = cwd.trim().replace(/^\.?\//, '');
            hostWorkDir = path.resolve(this.workspaceRoot, cleanCwd);
        }

        // Check compile_commands.json status before command execution
        const compileCommandsPath = path.join(hostWorkDir, 'compile_commands.json');
        const beforeStats = this.getFileStats(compileCommandsPath);

        // Step 2: Build docker exec command
        // Format: docker exec -i -w <workdir> -u <uid>:<gid> <container> bash -c "cd <dir> && <cmd>"
        const uid = child_process.execSync('id -u').toString().trim();
        const gid = child_process.execSync('id -g').toString().trim();
        
        const dockerArgs = [
            'exec',
            '-i',
            '-w', '/sandbox',
            '-u', `${uid}:${gid}`,
            containerName,
            'bash', '-c',
            `cd ${containerWorkDir} && ${command}`
        ];

        // Show progress
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `🐳 Executing in container: ${command}`,
            cancellable: true
        }, async (progress, token) => {
            return new Promise<void>((resolve) => {
                // Execute command
                this.currentProcess = child_process.spawn('docker', dockerArgs, {
                    cwd: this.workspaceRoot
                });

                // Handle cancellation
                token.onCancellationRequested(() => {
                    this.stop();
                    resolve();
                });

                // Listen to stdout
                if (this.currentProcess.stdout) {
                    this.currentProcess.stdout.on('data', (data: Buffer) => {
                        const output = data.toString();
                        this.outputManager.append(output);
                    });
                }

                // Listen to stderr
                // Note: Many commands output normal progress info to stderr, not just errors
                // So we don't add [ERROR] prefix here, just output as-is
                if (this.currentProcess.stderr) {
                    this.currentProcess.stderr.on('data', (data: Buffer) => {
                        const output = data.toString();
                        this.outputManager.append(output);
                    });
                }

                // Listen to error events
                this.currentProcess.on('error', (error: Error) => {
                    this.outputManager.appendLine(`\n[Error] ${error.message}`);
                    vscode.window.showErrorMessage(`Command execution failed: ${error.message}`);
                    this.currentProcess = undefined;
                    resolve();
                });

                // Listen to close events
                this.currentProcess.on('close', async (code: number | null, signal: string | null) => {
                    this.outputManager.appendLine(`\n----------------------------------------`);
                    
                    if (signal) {
                        this.outputManager.appendLine(`Command terminated by signal: ${signal}`);
                        vscode.window.showWarningMessage(`Command terminated`);
                    } else if (code === 0) {
                        this.outputManager.appendLine(`Command executed successfully (exit code: ${code})`);
                        
                        // Check if compile_commands.json was updated
                        const afterStats = this.getFileStats(compileCommandsPath);
                        if (this.isCompileCommandsUpdated(beforeStats, afterStats)) {
                            this.outputManager.appendLine(`[Clangd] compile_commands.json has been updated`);
                            // Restart clangd language server
                            await this.restartClangd(compileCommandsPath);
                        } else {
                            vscode.window.showInformationMessage(`Command executed successfully`);
                        }
                    } else {
                        this.outputManager.appendLine(`Command execution failed (exit code: ${code})`);
                        vscode.window.showErrorMessage(`Command failed with exit code: ${code}`);
                    }
                    
                    this.outputManager.appendLine(`----------------------------------------\n`);
                    this.currentProcess = undefined;
                    resolve();
                });
            });
        });
    }

    /**
     * Execute shell command
     * @param command Command to execute
     * @param cwd Working directory (relative path)
     *            - Host mode: relative to workspace root
     *            - Docker mode: relative to /sandbox in container
     * @param executeLocally Per-command switch to execute locally (optional)
     */
    async execute(command: string, cwd?: string, executeLocally?: boolean): Promise<void> {
        // Check if workspace root is valid (checked once on initialization)
        if (!this.workspaceRootValid) {
            this.outputManager.appendLine(`\n[Error] Workspace root does not meet requirements, cannot execute command`);
            vscode.window.showErrorMessage('Workspace root does not meet requirements. Please open the project in the correct directory');
            return;
        }

        // Get configuration
        const config = vscode.workspace.getConfiguration('deeproute-compile-commands');
        const globalExecuteLocally = config.get<boolean>('executeLocally', false);
        const dockerContainerName = config.get<string>('dockerContainerName', 'deeproute-dev-x86-2004');
        
        // Check if should execute locally
        // Priority: per-command switch OR global switch
        const shouldExecuteLocally = executeLocally === true || globalExecuteLocally === true;
        
        if (shouldExecuteLocally) {
            // Execute locally
            await this.executeLocally(command, cwd);
        } else {
            // Execute in Docker container
            // Docker container must be configured (use default if not set)
            if (!dockerContainerName || !dockerContainerName.trim()) {
                this.outputManager.show();
                this.outputManager.appendLine(`\n========================================`);
                this.outputManager.appendLine(`❌ Docker Container Not Configured`);
                this.outputManager.appendLine(`========================================`);
                this.outputManager.appendLine(`\nThis plugin requires Docker container configuration.`);
                this.outputManager.appendLine(`\n💡 How to configure:`);
                this.outputManager.appendLine(`   1. Open Command Palette (Ctrl/Cmd + Shift + P)`);
                this.outputManager.appendLine(`   2. Search: "DeepRoute Compile Commands: Configure Docker Container"`);
                this.outputManager.appendLine(`   3. Enter your container name (e.g., deeproute-dev-x86-2004)`);
                this.outputManager.appendLine(`\n   Or manually add to settings.json:`);
                this.outputManager.appendLine(`   "deeproute-compile-commands.dockerContainerName": "your-container-name"`);
                this.outputManager.appendLine(`\n========================================\n`);
                
                vscode.window.showErrorMessage(
                    'Docker container is not configured. Please configure it in settings.',
                    'Configure Now'
                ).then(selection => {
                    if (selection === 'Configure Now') {
                        vscode.commands.executeCommand('deeproute-compile-commands.configureDocker');
                    }
                });
                return;
            }

            await this.executeInDocker(dockerContainerName.trim(), command, cwd);
        }
    }

    /**
     * Execute command locally (not in Docker)
     * @param command Command to execute
     * @param cwd Working directory (relative path)
     */
    private async executeLocally(command: string, cwd?: string): Promise<void> {
        // Stop current process if any
        if (this.currentProcess) {
            const shouldStop = await vscode.window.showWarningMessage(
                'A command is currently running. Stop it?',
                'Stop and Execute New Command',
                'Cancel'
            );

            if (shouldStop !== 'Stop and Execute New Command') {
                return;
            }

            this.stop();
        }

        // Determine actual working directory (host mode)
        let actualCwd = this.workspaceRoot;
        if (cwd && cwd.trim()) {
            actualCwd = path.resolve(this.workspaceRoot, cwd.trim());
            
            // Check if directory exists
            if (!fs.existsSync(actualCwd)) {
                vscode.window.showErrorMessage(`Specified directory does not exist: ${actualCwd}`);
                return;
            }
        }

        // Check compile_commands.json status before command execution
        const compileCommandsPath = path.join(actualCwd, 'compile_commands.json');
        const beforeStats = this.getFileStats(compileCommandsPath);

        // Get configuration
        const config = vscode.workspace.getConfiguration('deeproute-compile-commands');
        const customShell = config.get<string>('shell', '');
        const customEnv = config.get<Record<string, string>>('env', {});

        // Prepare environment variables
        const env = {
            ...process.env,
            ...customEnv
        };

        // Show output panel
        this.outputManager.show();
        this.outputManager.appendLine(`\n========================================`);
        this.outputManager.appendLine(`Executing: ${command}`);
        this.outputManager.appendLine(`🖥️  Execution Mode: Local`);
        this.outputManager.appendLine(`📁 Working Dir: ${actualCwd}`);
        this.outputManager.appendLine(`Time: ${new Date().toLocaleString()}`);
        this.outputManager.appendLine(`========================================\n`);

        // Prepare spawn options
        const spawnOptions: child_process.SpawnOptions = {
            cwd: actualCwd,
            env: env,
            shell: customShell || true
        };

        // Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Executing: ${command}`,
            cancellable: true
        }, async (progress, token) => {
            return new Promise<void>((resolve) => {
                // Execute command
                this.currentProcess = child_process.spawn(command, [], spawnOptions);

                // Handle cancellation
                token.onCancellationRequested(() => {
                    this.stop();
                    resolve();
                });

                // Listen to stdout
                if (this.currentProcess.stdout) {
                    this.currentProcess.stdout.on('data', (data: Buffer) => {
                        const output = data.toString();
                        this.outputManager.append(output);
                    });
                }

                // Listen to stderr
                if (this.currentProcess.stderr) {
                    this.currentProcess.stderr.on('data', (data: Buffer) => {
                        const output = data.toString();
                        this.outputManager.append(output);
                    });
                }

                // Listen to error events
                this.currentProcess.on('error', (error: Error) => {
                    this.outputManager.appendLine(`\n[Error] ${error.message}`);
                    vscode.window.showErrorMessage(`Command execution failed: ${error.message}`);
                    this.currentProcess = undefined;
                    resolve();
                });

                // Listen to close events
                this.currentProcess.on('close', async (code: number | null, signal: string | null) => {
                    this.outputManager.appendLine(`\n----------------------------------------`);
                    
                    if (signal) {
                        this.outputManager.appendLine(`Command terminated by signal: ${signal}`);
                        vscode.window.showWarningMessage(`Command terminated`);
                    } else if (code === 0) {
                        this.outputManager.appendLine(`Command executed successfully (exit code: ${code})`);
                        
                        // Check if compile_commands.json was updated
                        const afterStats = this.getFileStats(compileCommandsPath);
                        if (this.isCompileCommandsUpdated(beforeStats, afterStats)) {
                            this.outputManager.appendLine(`[Clangd] compile_commands.json has been updated`);
                            // Restart clangd language server
                            await this.restartClangd(compileCommandsPath);
                        } else {
                            vscode.window.showInformationMessage(`Command executed successfully`);
                        }
                    } else {
                        this.outputManager.appendLine(`Command execution failed (exit code: ${code})`);
                        vscode.window.showErrorMessage(`Command failed with exit code: ${code}`);
                    }
                    
                    this.outputManager.appendLine(`----------------------------------------\n`);
                    this.currentProcess = undefined;
                    resolve();
                });
            });
        });
    }

    /**
     * Stop currently executing command
     */
    stop(): void {
        if (this.currentProcess) {
            this.outputManager.appendLine(`\n[Stop] Terminating command execution...`);
            
            // Try to terminate process gracefully
            this.currentProcess.kill('SIGTERM');
            
            // Force kill if still running after 3 seconds
            setTimeout(() => {
                if (this.currentProcess && !this.currentProcess.killed) {
                    this.currentProcess.kill('SIGKILL');
                }
            }, 3000);
            
            this.currentProcess = undefined;
            vscode.window.showInformationMessage('Command execution stopped');
        } else {
            vscode.window.showInformationMessage('No command is currently running');
        }
    }

    /**
     * Check if command is running
     */
    isRunning(): boolean {
        return this.currentProcess !== undefined;
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        if (this.currentProcess) {
            this.currentProcess.kill('SIGKILL');
            this.currentProcess = undefined;
        }
    }

    /**
     * Get file stats
     */
    private getFileStats(filePath: string): { exists: boolean; mtime?: Date } {
        try {
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                return { exists: true, mtime: stats.mtime };
            }
        } catch (error) {
            // Ignore errors
        }
        return { exists: false };
    }

    /**
     * Check if compile_commands.json was updated
     */
    private isCompileCommandsUpdated(
        before: { exists: boolean; mtime?: Date },
        after: { exists: boolean; mtime?: Date }
    ): boolean {
        // Scenario 1: File didn't exist before, exists now
        if (!before.exists && after.exists) {
            return true;
        }

        // Scenario 2: File modification time changed
        if (before.exists && after.exists && before.mtime && after.mtime) {
            return after.mtime.getTime() > before.mtime.getTime();
        }

        return false;
    }

    /**
     * Replace container path with host path in compile_commands.json
     * Uses sed command for efficient processing of files of any size
     * @param filePath Path to compile_commands.json
     */
    private replaceCompileCommandsPath(filePath: string): boolean {
        try {
            this.outputManager.appendLine(`[Clangd] Updating real paths in compile_commands.json...`);
            
            // Check if file exists
            if (!fs.existsSync(filePath)) {
                this.outputManager.appendLine(`[Clangd] File does not exist: ${filePath}`);
                return false;
            }
            
            // Get file size
            const stats = fs.statSync(filePath);
            const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
            this.outputManager.appendLine(`[Clangd] File size: ${fileSizeMB} MB`);
            
            // Check if file contains /sandbox to avoid unnecessary replacement
            const grepResult = child_process.spawnSync('grep', ['-q', '/sandbox', filePath]);
            
            if (grepResult.status !== 0) {
                this.outputManager.appendLine(`[Clangd] No /sandbox path found in file, no replacement needed`);
                return false;
            }
            
            this.outputManager.appendLine(`[Clangd] Using sed command for path replacement...`);
            
            // Count /sandbox occurrences before replacement
            const countBeforeResult = child_process.spawnSync('grep', ['-o', '/sandbox', filePath], {
                maxBuffer: 1024 * 1024 * 50
            });
            const countBefore = countBeforeResult.stdout.toString().split('\n').filter(line => line.trim()).length;
            
            // Use sed for in-place replacement
            // sed -i 's|/sandbox|actual_path|g' file
            const sedCommand = `sed -i 's|/sandbox|${this.workspaceRoot}|g' "${filePath}"`;
            
            try {
                const startTime = Date.now();
                child_process.execSync(sedCommand, {
                    cwd: this.workspaceRoot,
                    maxBuffer: 1024 * 1024 * 100, // 100MB buffer
                    timeout: 120000 // 120 seconds timeout
                });
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                
                this.outputManager.appendLine(`[Clangd] ✅ Path replacement completed (${duration}s, ${countBefore} occurrences): /sandbox → ${this.workspaceRoot}`);
                return true;
            } catch (sedError: any) {
                this.outputManager.appendLine(`[Clangd] ❌ sed command failed: ${sedError.message}`);
                this.outputManager.appendLine(`[Clangd] Hint: Run manually: sed -i 's|/sandbox|${this.workspaceRoot}|g' ${filePath}`);
                return false;
            }
        } catch (error: any) {
            this.outputManager.appendLine(`[Clangd] ❌ Path replacement failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Restart clangd language server
     * @param compileCommandsPath Path to compile_commands.json
     */
    private async restartClangd(compileCommandsPath: string): Promise<void> {
        try {
            this.outputManager.appendLine(`[Clangd] Preparing to reload compile_commands.json and index C++ symbols...`);
            
            // Replace paths in file
            const replaced = this.replaceCompileCommandsPath(compileCommandsPath);
            
            // Check available clangd commands
            const allCommands = await vscode.commands.getCommands();
            const clangdCommands = allCommands.filter(cmd => cmd.startsWith('clangd'));
            
            if (clangdCommands.length === 0) {
                this.outputManager.appendLine(`[Clangd] ⚠️  clangd extension not detected, cannot auto-restart language server`);
                this.outputManager.appendLine(`[Clangd] Hint: Please manually execute "clangd: Restart language server" command`);
                vscode.window.showWarningMessage('clangd extension not detected. Please restart clangd manually or install the clangd extension');
                return;
            }
            
            // Execute clangd restart command
            this.outputManager.appendLine(`[Clangd] Executing VS Code/Cursor command: clangd: Restart language server, please wait...`);
            await vscode.commands.executeCommand('clangd.restart');
            
            this.outputManager.appendLine(`[Clangd] ✅ clangd.restart command sent successfully`);
            this.outputManager.appendLine(`[Clangd] clangd is reloading compile_commands.json and indexing C++ symbols in background...`);
            this.outputManager.appendLine(`[Clangd] Hint: Indexing may take seconds to minutes, check VS Code/Cursor status bar (bottom right)`);
            
            vscode.window.showInformationMessage('✅ compile_commands.json updated, clangd is re-indexing (check status bar)');
        } catch (error: any) {
            // If clangd command doesn't exist or execution failed
            this.outputManager.appendLine(`[Clangd] ❌ Failed to restart language server: ${error.message || 'Command execution failed'}`);
            this.outputManager.appendLine(`[Clangd] Hint: Please manually execute "clangd: Restart language server" command`);
            vscode.window.showErrorMessage(`clangd restart failed: ${error.message || 'Unknown error'}`);
        }
    }

    /**
     * Check if workspace root is $HOME/codetree/repo
     * Called once during plugin initialization
     */
    private checkWorkspaceRoot(): boolean {
        const homeDir = os.homedir();
        const expectedRoot = path.join(homeDir, 'codetree', 'repo');
        
        if (this.workspaceRoot !== expectedRoot) {
            // Show error notification (no log output as this may be during initialization)
            const errorMsg = `Workspace root must be $HOME/codetree/repo\nExpected: ${expectedRoot}\nActual: ${this.workspaceRoot}`;
            vscode.window.showErrorMessage(errorMsg, { modal: false });
            return false;
        }
        
        return true;
    }
}
