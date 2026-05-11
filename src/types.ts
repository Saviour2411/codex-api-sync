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
  problems: string[];
  warnings: string[];
};
