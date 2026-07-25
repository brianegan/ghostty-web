/**
 * URL Regex Link Provider
 *
 * Detects plain text URLs using regex pattern matching.
 * Supports common protocols but excludes file paths.
 *
 * This provider runs after OSC8LinkProvider, so explicit hyperlinks
 * take precedence over regex-detected URLs.
 */

import type { IBufferRange, ILink, ILinkProvider } from '../types';

/**
 * URL Regex Provider
 *
 * Detects plain text URLs using regex, following soft wraps so a URL longer
 * than the terminal is wide is still found whole. Does not detect file paths.
 *
 * Supported protocols:
 * - https://, http://
 * - mailto:
 * - ftp://, ssh://, git://
 * - tel:, magnet:
 * - gemini://, gopher://, news:
 */
export class UrlRegexProvider implements ILinkProvider {
  /**
   * URL regex pattern
   * Matches common protocols followed by valid URL characters
   * Excludes file paths (no ./ or ../ or bare /)
   */
  private static readonly URL_REGEX =
    /(?:https?:\/\/|mailto:|ftp:\/\/|ssh:\/\/|git:\/\/|tel:|magnet:|gemini:\/\/|gopher:\/\/|news:)[\w\-.~:\/?#@!$&*+,;=%()]+/gi;

  /**
   * Characters to strip from end of URLs
   * Common punctuation that's unlikely to be part of the URL
   */
  private static readonly TRAILING_PUNCTUATION = /[.,;!?\]]+$/;

  constructor(private terminal: ITerminalForUrlProvider) {}

  /**
   * Provide all regex-detected URLs on the given row
   */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const links: ILink[] = [];

    // Assemble the whole logical line, not just this row.
    //
    // A URL longer than the terminal is wide soft-wraps across rows. Scanning a
    // single row found a "URL" truncated at exactly the terminal width, which
    // still looked clickable and often still resolved, just to the wrong place.
    // The continuation rows started mid-query-string and matched nothing at
    // all, so the back half of a wrapped link was simply dead.
    //
    // isWrapped marks a row as a continuation of the one above, so walking back
    // while it is set finds the logical start, and walking forward while the
    // next row has it finds the end.
    const buffer = this.terminal.buffer.active;

    let startY = y;
    while (startY > 0 && buffer.getLine(startY)?.isWrapped) startY--;

    const rows: { y: number; text: string; length: number }[] = [];
    for (let row = startY; ; row++) {
      const line = buffer.getLine(row);
      if (!line) break;
      rows.push({ y: row, text: this.lineToText(line), length: line.length });
      const next = buffer.getLine(row + 1);
      if (!next?.isWrapped) break;
    }

    if (rows.length === 0) {
      callback(undefined);
      return;
    }

    const lineText = rows.map((r) => r.text).join('');

    // Offset in the joined text back to a row and column.
    const locate = (offset: number): { x: number; y: number } => {
      let remaining = offset;
      for (const row of rows) {
        if (remaining < row.length) return { x: remaining, y: row.y };
        remaining -= row.length;
      }
      const last = rows[rows.length - 1]!;
      return { x: last.length - 1, y: last.y };
    };

    // Reset regex state (global flag maintains state)
    UrlRegexProvider.URL_REGEX.lastIndex = 0;

    // Find all URL matches in the line
    let match: RegExpExecArray | null = UrlRegexProvider.URL_REGEX.exec(lineText);
    while (match !== null) {
      let url = match[0];
      const startX = match.index;
      let endX = match.index + url.length - 1; // Inclusive end

      // Strip trailing punctuation
      const stripped = url.replace(UrlRegexProvider.TRAILING_PUNCTUATION, '');
      if (stripped.length < url.length) {
        url = stripped;
        endX = startX + url.length - 1;
      }

      // Strip unbalanced trailing parentheses
      while (url.endsWith(')')) {
        const open = url.split('(').length - 1;
        const close = url.split(')').length - 1;
        if (close > open) {
          url = url.slice(0, -1);
          endX--;
        } else {
          break;
        }
      }

      // Skip if URL is too short (e.g., just "http://")
      if (url.length > 8) {
        links.push({
          text: url,
          range: {
            start: locate(startX),
            end: locate(endX),
          },
          activate: (event) => {
            // Open link if Ctrl/Cmd is pressed
            if (event.ctrlKey || event.metaKey) {
              window.open(url, '_blank', 'noopener,noreferrer');
            }
          },
        });
      }

      // Get next match
      match = UrlRegexProvider.URL_REGEX.exec(lineText);
    }

    callback(links.length > 0 ? links : undefined);
  }

  /**
   * Convert a buffer line to plain text string
   */
  private lineToText(line: IBufferLineForUrlProvider): string {
    const chars: string[] = [];

    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) {
        chars.push(' ');
        continue;
      }

      const codepoint = cell.getCodepoint();
      // Skip null characters and control characters
      if (codepoint === 0 || codepoint < 32) {
        chars.push(' ');
      } else {
        chars.push(String.fromCodePoint(codepoint));
      }
    }

    return chars.join('');
  }

  dispose(): void {
    // No resources to clean up
  }
}

/**
 * Minimal terminal interface required by UrlRegexProvider
 */
export interface ITerminalForUrlProvider {
  buffer: {
    active: {
      getLine(y: number): IBufferLineForUrlProvider | undefined;
    };
  };
}

/**
 * Minimal buffer line interface for URL detection
 */
interface IBufferLineForUrlProvider {
  length: number;
  /** True when this row is a continuation of the one above it. */
  isWrapped?: boolean;
  getCell(x: number):
    | {
        getCodepoint(): number;
      }
    | undefined;
}
