declare module "cloudflare:workers" {
  export const exports: {
    default: {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  };
}
