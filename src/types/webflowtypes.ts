export interface WebflowAPI {
  getSiteInfo: () => Promise<{
    siteId: string;
    siteName: string;
    shortName: string;
    url: string;
    domains?: Array<{
      url: string;
      lastPublished: string | null;
      default: boolean;
      stage: 'staging' | 'production';
    }>;
  }>;
  getIdToken: () => Promise<string>;
  setExtensionSize: (size: 'default' | 'compact' | 'comfortable' | 'large' | { width: number; height: number }) => Promise<null>;
}
