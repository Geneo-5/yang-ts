export interface SourceLocation { offset: number; line: number; column: number }
export interface YangStatement {
  keyword: string;
  argument?: string;
  children: YangStatement[];
  location: SourceLocation;
}
export interface YangModule extends YangStatement {
  keyword: "module" | "submodule";
  argument: string;
}

export class YangSyntaxError extends Error {
  constructor(message: string, readonly location: SourceLocation) {
    super(`${message} (${location.line}:${location.column})`);
    this.name = "YangSyntaxError";
  }
}
