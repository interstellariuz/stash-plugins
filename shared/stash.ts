/**
 * The PluginApi Stash puts on window, typed only as far as these plugins use
 * it. react-bootstrap, react-intl and the rest are not dependencies: the
 * plugins borrow the copies Stash loaded, so there are no types to import.
 *
 * Read when a bundle starts; Stash loads plugin scripts after setting it.
 */

export type Component = React.FC<any>;
// Form.Check, Modal.Header and the like hang off their parent
export type Compound = Component & Record<string, Component>;
type PatchFn = (target: string, fn: (...args: any[]) => any) => void;

export interface Intl {
  // The whole catalogue: a string can be looked up without asking
  // formatMessage for an id the server may not have
  messages: Record<string, unknown>;
  formatMessage: (descriptor: { id: string }, values?: Record<string, unknown>) => string;
}

export interface Toast {
  success: (message: string) => void;
  error: (error: unknown) => void;
}

export interface IPluginApi {
  React: typeof import("react");
  GQL: Record<string, any>;
  libraries: {
    Apollo: { gql: (source: string | TemplateStringsArray, ...values: unknown[]) => unknown };
    Bootstrap: Record<string, Compound>;
    FontAwesomeSolid: Record<string, unknown>;
    Intl: { useIntl: () => Intl };
    ReactRouterDOM: {
      Link: Component;
      NavLink: Component;
      useLocation: () => { pathname: string; search: string };
    };
  };
  components: Record<string, Component>;
  hooks: {
    useToast: () => Toast;
    useLoadComponents: (toLoad: (() => Promise<unknown>)[]) => boolean;
  };
  loadableComponents: Record<string, () => Promise<unknown>>;
  register: { route: (path: string, component: React.FC<any>) => void };
  utils: { StashService: Record<string, any> };
  patch: { before: PatchFn; instead: PatchFn; after: PatchFn };
}

export const PluginApi = (window as any).PluginApi as IPluginApi;

// JSX compiles to React.createElement: every .tsx imports this binding
export const React = PluginApi.React;
export const StashService = PluginApi.utils.StashService;
export const Bootstrap = PluginApi.libraries.Bootstrap;
export const Router = PluginApi.libraries.ReactRouterDOM;
export const useIntl = PluginApi.libraries.Intl.useIntl;
