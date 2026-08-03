interface Env {
  FEEDS: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  REFRESH_TOKEN?: string;
}

declare module "*.png" {
  const data: ArrayBuffer;
  export default data;
}
