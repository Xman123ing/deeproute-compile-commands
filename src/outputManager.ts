import * as vscode from 'vscode';

export class OutputManager {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('DeepRoute Compile Commands');
    }

    /**
     * Strip ANSI escape codes from text
     * This removes color codes and other terminal formatting that VS Code Output Channel doesn't support
     * @param text Text with potential ANSI codes
     * @returns Clean text without ANSI codes
     */
    private stripAnsiCodes(text: string): string {
        // ANSI escape code regex: matches ESC[ followed by any control sequence
        // eslint-disable-next-line no-control-regex
        return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    }

    /**
     * Show output panel
     * @param preserveFocus Whether to preserve focus on current editor
     */
    show(preserveFocus: boolean = false): void {
        this.outputChannel.show(preserveFocus);
    }

    /**
     * Hide output panel
     */
    hide(): void {
        this.outputChannel.hide();
    }

    /**
     * Append text without newline
     * Automatically strips ANSI escape codes
     * @param text Text to append
     */
    append(text: string): void {
        const cleanText = this.stripAnsiCodes(text);
        this.outputChannel.append(cleanText);
    }

    /**
     * Append text with newline
     * Automatically strips ANSI escape codes
     * @param text Text to append
     */
    appendLine(text: string): void {
        const cleanText = this.stripAnsiCodes(text);
        this.outputChannel.appendLine(cleanText);
    }

    /**
     * Append error message with [ERROR] prefix
     * Automatically strips ANSI escape codes
     * @param text Error text
     */
    appendError(text: string): void {
        const cleanText = this.stripAnsiCodes(text);
        const lines = cleanText.split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                this.outputChannel.appendLine(`[ERROR] ${line}`);
            }
        });
    }

    /**
     * Append warning message with [WARNING] prefix
     * Automatically strips ANSI escape codes
     * @param text Warning text
     */
    appendWarning(text: string): void {
        const cleanText = this.stripAnsiCodes(text);
        const lines = cleanText.split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                this.outputChannel.appendLine(`[WARNING] ${line}`);
            }
        });
    }

    /**
     * Append success message with [SUCCESS] prefix
     * Automatically strips ANSI escape codes
     * @param text Success text
     */
    appendSuccess(text: string): void {
        const cleanText = this.stripAnsiCodes(text);
        const lines = cleanText.split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                this.outputChannel.appendLine(`[SUCCESS] ${line}`);
            }
        });
    }

    /**
     * Clear output panel
     */
    clear(): void {
        this.outputChannel.clear();
        vscode.window.showInformationMessage('Output cleared');
    }

    /**
     * Dispose output channel resources
     */
    dispose(): void {
        this.outputChannel.dispose();
    }
}
