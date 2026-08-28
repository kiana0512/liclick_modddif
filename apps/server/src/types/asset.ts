export type AssetCategory = 'models' | 'references' | 'captures' | 'generations' | 'layers' | 'baked';

export type SavedAsset = {
  category: AssetCategory;
  relativePath: string;
  url: string;
};
