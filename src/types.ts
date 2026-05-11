export type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  usesOpenAiAuth: boolean;
  experimentalBearerToken?: string;
  model?: string;
  wireApi: "responses";
  isActive: boolean;
};

export type ProviderInput = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model?: string;
};

export type ProviderUpdate = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

export type SyncResult = {
  changedFiles: string[];
  sqliteRowsUpdated: number;
  sqlitePresent: boolean;
  globalStateUpdated: boolean;
  warnings: string[];
};

export type ProviderCounts = Record<string, number>;

export type SessionSyncStatus = {
  targetProviderId?: string;
  needsSync: boolean;
  sessionFiles: ProviderCounts;
  sqlite: ProviderCounts;
  warnings: string[];
};

export type AutoRepairResult = {
  statusBefore: SessionSyncStatus;
  statusAfter?: SessionSyncStatus;
  sync?: SyncResult;
  repaired: boolean;
  warnings: string[];
};

export type SwitchResult = {
  provider: Provider;
  sync?: SyncResult;
  warnings: string[];
};

export type DoctorResult = {
  codexHome: string;
  activeProviderId?: string;
  activeProvider?: Provider;
  sessionSync?: AutoRepairResult;
  problems: string[];
  warnings: string[];
};
