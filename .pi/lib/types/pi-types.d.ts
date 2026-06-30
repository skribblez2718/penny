// Ambient module declarations for Pi framework packages
// These are loaded at runtime by Pi, not installed locally.
// Only declares that the modules exist — actual types are inferred
// by Pi at runtime from @sinclair/typebox schemas.

declare module "@mariozechner/pi-coding-agent" {
  export function getAgentDir(): string;
  export function parseFrontmatter<T>(content: string): { frontmatter: T; body: string };
  export function withFileMutationQueue(filePath: string, fn: () => Promise<void>): Promise<void>;
  export function getMarkdownTheme(): Record<string, (text: string) => string>;

  // Extension types
  export type ExtensionAPI = any;
  export type ExtensionContext = any;
  export type ExtensionCommandContext = any;
  export type AgentToolResult<T = any> = {
    content: Array<{ type: string; text: string }>;
    details?: T;
    isError?: boolean;
  };
  export type AgentToolUpdateCallback<T = any> = (partial: {
    content: Array<{ type: string; text: string }>;
    details: T;
  }) => void;
  export type Theme = ((color: string, text: string) => string) & {
    fg: (color: string, text: string) => string;
  };
  export type ToolRenderResultOptions = { expanded: boolean };
}

declare module "@mariozechner/pi-tui" {
  export class Container {
    addChild(child: any): void;
  }
  export class Text {
    constructor(text: string, x: number, y: number, theme?: any);
  }
  export class Spacer {
    constructor(size: number);
  }
  export class Markdown {
    constructor(text: string, x: number, y: number, theme?: any);
  }
  export class Editor {
    constructor(tui: any, theme: any);
    getValue(): string;
    setValue(v: string): void;
    setTheme(t: any): void;
    setText(text: string): void;
    handleInput(key: string): void;
    onSubmit: ((value: string) => void) | null;
    render(width?: number): string[];
  }
  export interface EditorTheme {
    bg?: string;
    fg?: string;
    cursor?: string;
    selection?: string;
    borderColor?: (s: string) => string;
    selectList?: {
      selectedPrefix?: (t: string) => string;
      selectedText?: (t: string) => string;
      description?: (t: string) => string;
      scrollInfo?: (t: string) => string;
      noMatch?: (t: string) => string;
    };
  }
  export class Key {
    static parse(s: string): { name: string; ctrl: boolean; meta: boolean; shift: boolean };
    static escape(s: string): string;
    static enter(s: string): string;
    static tab(s: string): string;
    static up(s: string): string;
    static down(s: string): string;
    static left(s: string): string;
    static right(s: string): string;
    static shift(s: string): string;
    static ctrl(s: string): string;
    static alt(s: string): string;
    static escape: any;
    static enter: any;
    static tab: any;
    static up: any;
    static down: any;
    static left: any;
    static right: any;
    static shift: any;
    static ctrl: any;
    static alt: any;
  }
  export function matchesKey(key: any, binding: any): boolean;
  export function truncateToWidth(text: string, width: number): string;
}

declare module "@mariozechner/pi-ai" {
  export interface Message {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      arguments?: Record<string, unknown>;
    }>;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens?: number;
      cost?: { total: number };
    };
    model?: string;
    stopReason?: string;
    errorMessage?: string;
  }
  export function StringEnum(values: readonly string[], options?: Record<string, unknown>): any;
}

declare module "@mariozechner/pi-agent-core" {
  export interface AgentToolResult<T = any> {
    content: Array<{ type: string; text: string }>;
    details?: T;
    isError?: boolean;
  }
}

declare namespace NodeJS {
  interface Timeout {
    unref(): void;
    ref(): void;
  }
  interface Immediate {
    unref(): void;
    ref(): void;
  }
}
