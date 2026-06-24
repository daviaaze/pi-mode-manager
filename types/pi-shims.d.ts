declare module "@earendil-works/pi-agent-core" {
  export type AgentMessage = any;
}

declare module "@earendil-works/pi-ai" {
  export type AssistantMessage = any;
  export type TextContent = any;
}

declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = any;
  export type ExtensionContext = any;
}

declare module "@earendil-works/pi-tui" {
  export const Key: any;
  export type AutocompleteItem = {
    value: string;
    label: string;
    description?: string;
  };
}
