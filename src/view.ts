import type { FeedDoc } from "./normalize";

export function renderFeedPage(doc: FeedDoc, feedUrl: string, stale: string | null): string {
  return `<!doctype html><title>${doc.title}</title><p>Subscribe</p>`;
}
