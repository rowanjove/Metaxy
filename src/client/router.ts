export type RouteHandler = (params: Record<string, string>) => HTMLElement | Promise<HTMLElement>;

interface RouteDef {
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: RouteDef[] = [];
  private outlet: HTMLElement | null = null;
  private navigationVersion = 0;

  constructor() {
    window.addEventListener("popstate", () => this.resolve());
  }

  public setOutlet(el: HTMLElement): void {
    this.outlet = el;
  }

  public addRoute(path: string, handler: RouteHandler): this {
    const paramNames: string[] = [];
    const patternStr = path
      .replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return "([^/]+)";
      })
      .replace(/\//g, "\\/");

    const pattern = new RegExp(`^${patternStr}$`);
    this.routes.push({ pattern, paramNames, handler });
    return this;
  }

  public navigate(path: string): void {
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    this.resolve();
  }

  public async resolve(): Promise<void> {
    if (!this.outlet) return;
    const version = ++this.navigationVersion;

    const pathname = window.location.pathname;
    for (const route of this.routes) {
      const match = pathname.match(route.pattern);
      if (match) {
        try {
          const params: Record<string, string> = {};
          for (let i = 0; i < route.paramNames.length; i++) {
            params[route.paramNames[i]] = decodeURIComponent(match[i + 1]);
          }
          const element = await route.handler(params);
          if (version !== this.navigationVersion || !this.outlet) return;
          this.outlet.replaceChildren(element);
        } catch (err) {
          console.error("[Router] Error rendering route", err);
          if (version !== this.navigationVersion || !this.outlet) return;
          const error = document.createElement("div");
          error.className = "notice-box is-error";
          error.textContent = "Unable to load this page. Please try again.";
          this.outlet.replaceChildren(error);
        }
        return;
      }
    }

    // Default: Fallback to home
    if (pathname !== "/") {
      this.navigate("/");
    }
  }
}

export const router = new Router();
