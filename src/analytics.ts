export function classifyUa(ua: string): { kind: "aggregator" | "browser" | "other"; subscribers: number } {
  return { kind: "other", subscribers: 0 };
}

export function recordRequest(env: Env, feedId: string, request: Request): void {}
