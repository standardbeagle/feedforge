declare module "cloudflare:test" {
  interface ProvidedEnv {
    FEEDS: KVNamespace;
    ANALYTICS: AnalyticsEngineDataset;
  }
}
