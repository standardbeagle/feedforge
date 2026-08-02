declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args?: string[],
    options?: { encoding?: string; stdio?: unknown },
  ): string;
}

declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: string): string;
}

declare const process: {
  argv: string[];
  exit(code?: number): never;
};

interface ImportMeta {
  url: string;
}
