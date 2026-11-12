type PatchFn = (target: string, fn: (...args: any[]) => any) => void;

interface IConfigurationResult {
  data?: {
    configuration?: {
      plugins?: Record<string, Record<string, unknown>>;
    };
  };
}

interface IPluginApi {
  React: typeof React;
  libraries: {
    Bootstrap: {
      Button: React.FC<any>;
      ButtonGroup: React.FC<any>;
    };
  };
  utils: {
    StashService: {
      useConfiguration: () => IConfigurationResult;
    };
  };
  patch: {
    before: PatchFn;
    instead: PatchFn;
    after: PatchFn;
  };
}

(function () {
  const PluginApi = (window as any).PluginApi as IPluginApi;
  const React = PluginApi.React;
  const { Button, ButtonGroup } = PluginApi.libraries.Bootstrap;
  const { useConfiguration } = PluginApi.utils.StashService;

  const PLUGIN_ID = "inzDateSelect";
  const DEFAULT_SPREAD = 45;
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const DAY_MS = 24 * 60 * 60 * 1000;

  type Mode = "off" | "same" | "near";

  interface ISettings {
    spread: number;
    sortByProximity: boolean;
  }

  interface IDated {
    date?: string | null;
  }

  // The sort patches are plain functions and cannot use hooks, so the wrapper
  // that currently has a date filter active publishes its state here.
  let activeSort: { refDate: string; enabled: boolean } | null = null;

  function parseDate(value: string | null | undefined): number | null {
    if (!value || !DATE_PATTERN.test(value)) return null;
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function shiftDays(value: string, days: number): string {
    const parsed = parseDate(value)!;
    return new Date(parsed + days * DAY_MS).toISOString().slice(0, 10);
  }

  // ListFilterModel.makeFilter() only ever calls applyToCriterionInput() on the
  // entries of extraCriteria, so a structural stand-in is enough here — the real
  // DateCriterion class is not reachable from a plugin.
  function dateCriterion(modifier: string, value: string, value2?: string) {
    return {
      criterionOption: { type: "date" },
      applyToCriterionInput(input: Record<string, unknown>) {
        input.date = { modifier, value, value2 };
      },
    };
  }

  // PluginApi.hooks.useSettings() is unusable here: its SettingsContext provider
  // only wraps the settings page, not the edit panels.
  //
  // Stash has no notion of a default for a plugin setting — the settings page shows
  // an unset NUMBER as 0 and an unset BOOLEAN as off. So the unset value has to mean
  // the default: 0 spread falls back to DEFAULT_SPREAD, and the boolean is phrased
  // negatively so that off is the desired behaviour.
  function usePluginSettings(): ISettings {
    const { data } = useConfiguration();

    return React.useMemo(() => {
      const raw = data?.configuration?.plugins?.[PLUGIN_ID] ?? {};
      const spread = Number(raw.similarDaysSpread);

      return {
        spread:
          Number.isFinite(spread) && spread > 0
            ? Math.floor(spread)
            : DEFAULT_SPREAD,
        sortByProximity: raw.disableProximitySort !== true,
      };
    }, [data]);
  }

  function resortByProximity<T extends IDated>(items: T[]): T[] {
    if (!activeSort?.enabled) return items;

    const base = parseDate(activeSort.refDate);
    if (base === null) return items;

    return items
      .map((item, index) => {
        const date = parseDate(item.date);
        return {
          item,
          index,
          distance: date === null ? Number.MAX_SAFE_INTEGER : Math.abs(date - base),
        };
      })
      .sort((a, b) => a.distance - b.distance || a.index - b.index)
      .map((entry) => entry.item);
  }

  interface IWrapperConfig {
    // data-field of the form group the select must sit in
    ownField: string;
    // data-field that must also be present in the same form, to tell apart panels
    // that share ownField (SceneEditPanel has groups, ImageEditPanel does not)
    siblingField: string | null;
  }

  function findDateInput(
    marker: HTMLElement | null,
    cfg: IWrapperConfig
  ): HTMLInputElement | null {
    if (!marker?.closest(`[data-field="${cfg.ownField}"]`)) return null;

    const form = marker.closest("form");
    if (!form) return null;
    if (cfg.siblingField && !form.querySelector(`[data-field="${cfg.siblingField}"]`)) {
      return null;
    }

    return form.querySelector<HTMLInputElement>('[data-field="date"] input.date-input');
  }

  function createDateSelect(cfg: IWrapperConfig): React.FC<any> {
    return function InzDateSelect(props: any) {
      const { __next: Next, ...rest } = props;

      const markerRef = React.useRef<HTMLDivElement>(null);
      const settings = usePluginSettings();
      const [inTargetForm, setInTargetForm] = React.useState(false);
      const [refDate, setRefDate] = React.useState<string | null>(null);
      const [mode, setMode] = React.useState<Mode>("off");
      const [openOnRemount, setOpenOnRemount] = React.useState(false);

      // The edit panels re-render on every formik change, so re-reading the date
      // input on each render keeps the filter in sync with unsaved edits.
      React.useEffect(() => {
        const input = findDateInput(markerRef.current, cfg);
        // parseDate, not just the pattern: the field takes free text, and a
        // well-shaped but impossible date such as 2024-13-45 must not reach
        // shiftDays.
        const value = input && parseDate(input.value) !== null ? input.value : null;

        setInTargetForm(input !== null);
        setRefDate((prev) => (prev === value ? prev : value));
      });

      const activeMode: Mode = refDate ? mode : "off";

      const extraCriteria = React.useMemo(() => {
        if (activeMode === "off" || !refDate) return rest.extraCriteria;

        const criterion =
          activeMode === "same"
            ? dateCriterion("EQUALS", refDate)
            : dateCriterion(
                "BETWEEN",
                shiftDays(refDate, -settings.spread),
                shiftDays(refDate, settings.spread)
              );

        return [...(rest.extraCriteria ?? []), criterion];
      }, [activeMode, refDate, settings.spread, rest.extraCriteria]);

      // Published during render rather than from an effect: the remount below
      // starts fetching options from the child's own mount effect, which runs
      // before the parent's, and that fetch must already see this date.
      if (inTargetForm) {
        activeSort =
          activeMode !== "off" && refDate
            ? { refDate, enabled: settings.sortByProximity }
            : null;
      }

      const isTargetRef = React.useRef(inTargetForm);
      isTargetRef.current = inTargetForm;

      React.useEffect(
        () => () => {
          if (isTargetRef.current) activeSort = null;
        },
        []
      );

      function toggle(next: Mode) {
        const value = mode === next ? "off" : next;
        setMode(value);
        setOpenOnRemount(value !== "off");
      }

      // react-select/async loads its options on mount and ignores later
      // loadOptions changes, so a new filter only takes effect on remount.
      const key = `${activeMode}|${refDate ?? ""}`;
      const menuProps =
        openOnRemount && activeMode !== "off"
          ? { autoFocus: true, defaultMenuIsOpen: true }
          : {};

      function renderButton(buttonMode: Mode, label: string, title: string) {
        return (
          <Button
            variant={activeMode === buttonMode ? "primary" : "secondary"}
            disabled={!refDate}
            title={refDate ? title : "Set a date on this form first"}
            onClick={() => toggle(buttonMode)}
          >
            {label}
          </Button>
        );
      }

      return (
        <>
          <Next {...rest} key={key} extraCriteria={extraCriteria} {...menuProps} />
          <div className="inz-date-filter" ref={markerRef}>
            {inTargetForm && (
              <ButtonGroup size="sm">
                {renderButton("same", "Same date", "Only entries dated exactly like this one")}
                {renderButton(
                  "near",
                  `±${settings.spread} d`,
                  `Entries dated within ${settings.spread} days of this one`
                )}
              </ButtonGroup>
            )}
          </div>
        </>
      );
    };
  }

  const GalleryDateSelect = createDateSelect({
    ownField: "gallery_ids",
    siblingField: "groups",
  });
  const SceneDateSelect = createDateSelect({
    ownField: "scene_ids",
    siblingField: null,
  });

  // React calls function components as fn(props, legacyContext), so the original
  // render function that patch.instead appends lands in the third argument.
  PluginApi.patch.instead(
    "GallerySelect",
    (props: any, _context: any, original: React.FC<any>) =>
      React.createElement(GalleryDateSelect, { ...props, __next: original })
  );

  PluginApi.patch.instead(
    "SceneSelect",
    (props: any, _context: any, original: React.FC<any>) =>
      React.createElement(SceneDateSelect, { ...props, __next: original })
  );

  // PatchFunction invokes after-hooks as args.concat(result). The sort result is an
  // array and Array.prototype.concat flattens it, so the items arrive spread over
  // the trailing arguments instead of as one array. The Array.isArray branch keeps
  // this working if Stash ever passes the result unflattened.
  function sortPatch(_input: string, _items: IDated[], ...result: unknown[]): IDated[] {
    const items =
      result.length === 1 && Array.isArray(result[0])
        ? (result[0] as IDated[])
        : (result as IDated[]);

    return resortByProximity(items);
  }

  PluginApi.patch.after("GallerySelect.sort", sortPatch);
  PluginApi.patch.after("SceneSelect.sort", sortPatch);
})();
