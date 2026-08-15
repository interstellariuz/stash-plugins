/**
 * UI half of VR Generated Content.
 *
 * Stash offers a plugin nothing but a list of argument-less task buttons, so
 * everything that describes one run -- which artifacts, for which scenes, in
 * which VR format -- has to be asked for here and handed over as args_map.
 *
 * Three ways in, and all three are meant to be indistinguishable from Stash's
 * own generation apart from the format select:
 *
 *   - "Generate as VR…" in the scene list's … menu, next to "Generate…";
 *   - the same entry in a single scene's … menu;
 *   - a Generate / Selective Generate pair under Settings > Tasks, shaped like
 *     the Generated Content section above it.
 */

type PatchFn = (target: string, fn: (...args: any[]) => any) => void;
type Component = React.FC<any>;

// Only the shapes this file touches. react-bootstrap and react-intl are not
// dependencies of this repository -- the plugin borrows the copies Stash
// already loaded -- so there are no types to import.
interface IPluginApi {
  React: typeof React;
  GQL: Record<string, any>;
  libraries: {
    Bootstrap: {
      Button: Component;
      Col: Component;
      Dropdown: Component & { Item: Component };
      Form: Component & {
        Control: Component;
        Group: Component;
        Label: Component;
        Text: Component;
      };
      Modal: Component & {
        Header: Component;
        Title: Component;
        Body: Component;
        Footer: Component;
      };
      Row: Component;
    };
    FontAwesomeSolid: { faMinus: unknown; faPlus: unknown };
    Intl: {
      useIntl: () => {
        formatMessage: (
          descriptor: { id: string },
          values?: Record<string, unknown>
        ) => string;
      };
    };
  };
  components: Record<string, Component>;
  hooks: { useToast: () => { success: (m: string) => void; error: (e: unknown) => void } };
  utils: { StashService: Record<string, any> };
  patch: { before: PatchFn; instead: PatchFn; after: PatchFn };
}

(function () {
  const PluginApi = (window as any).PluginApi as IPluginApi;
  const React = PluginApi.React;
  const { Button, Col, Dropdown, Form, Modal, Row } = PluginApi.libraries.Bootstrap;
  const { faMinus, faPlus } = PluginApi.libraries.FontAwesomeSolid;
  const { useIntl } = PluginApi.libraries.Intl;
  const StashService = PluginApi.utils.StashService;

  const PLUGIN_ID = "inzVrGenerate";
  const TASK_NAME = "Generate";
  const DIALOG_TITLE = "Generate as VR";
  const MENU_LABEL = `${DIALOG_TITLE}…`;

  /* ------------------------------------------------------------------ *
   * VR formats -- the mirror of the table in vrformat.py
   * ------------------------------------------------------------------ */

  interface IFormat {
    value: string;
    label: string;
    tokens?: string;
  }

  // `tokens` becomes the option's title attribute, which is the only place a
  // person can find out what `auto` actually looks for.
  const FORMATS: IFormat[] = [
    { value: "auto", label: "Auto — from the filename", tokens: "Reads the tokens listed against each format below. A file carrying none of them is left alone." },
    { value: "sbs", label: "Side-by-side, 180°", tokens: "LR, SBS, 3DH, 180_SBS, 180x180_3dh" },
    { value: "tb", label: "Over/under, 180°", tokens: "TB, OU, OVERUNDER, TOPBOTTOM, 3DV, 180x180_3dv" },
    { value: "sbs360", label: "Side-by-side, 360°", tokens: "360_SBS, 360_LR, 360x180_3dh" },
    { value: "tb360", label: "Over/under, 360°", tokens: "360_TB, 360_OU, 360x180_3dv" },
    { value: "fisheye190", label: "Fisheye 190°, side-by-side", tokens: "FISHEYE190, RF52" },
    { value: "fisheye200", label: "Fisheye 200°, side-by-side", tokens: "MKX200" },
    { value: "fisheye220", label: "Fisheye 220°, side-by-side", tokens: "MKX220, VRCA220" },
    { value: "mono", label: "Mono — 180° or 360°, no stereo pair", tokens: "MONO, 180_MONO, 360_MONO" },
  ];

  /* ------------------------------------------------------------------ *
   * Options and the task call
   * ------------------------------------------------------------------ */

  interface IPreviewOptions {
    previewSegments?: number;
    previewSegmentDuration?: number;
    previewExcludeStart?: string;
    previewExcludeEnd?: string;
  }

  interface IOptions {
    covers: boolean;
    previews: boolean;
    imagePreviews: boolean;
    sprites: boolean;
    overwrite: boolean;
    format: string;
    previewOptions?: IPreviewOptions;
  }

  // The same four Stash's own Generate dialog starts with, plus auto.
  function defaultOptions(): IOptions {
    return {
      covers: true,
      previews: true,
      imagePreviews: true,
      sprites: true,
      overwrite: false,
      format: "auto",
    };
  }

  // imagePreviews is deliberately not counted: it is a sub-setting of previews
  // and, as in Stash, does nothing on its own.
  function nothingSelected(options: IOptions) {
    return !options.covers && !options.previews && !options.sprites;
  }

  /**
   * Queue the task.
   *
   * Not StashService.mutateRunPluginTask: its document declares $args_map but it
   * passes the variable as `args`, so the arguments are dropped on the floor and
   * the task would run with its defaultArgs only. Going through the app's own
   * Apollo client keeps its authentication and error handling.
   */
  function runTask(options: IOptions, target: { sceneIds?: string[]; paths?: string[] }) {
    const args: Record<string, unknown> = {
      // Sent even when false: defaultArgs fill in whatever the caller omits, so
      // an unticked switch has to say so rather than simply not be there.
      covers: options.covers,
      previews: options.previews,
      imagePreviews: options.imagePreviews,
      sprites: options.sprites,
      overwrite: options.overwrite,
      format: options.format,
      ...(options.previews ? options.previewOptions ?? {} : {}),
    };
    if (target.sceneIds?.length) args.sceneIds = target.sceneIds;
    if (target.paths?.length) args.paths = target.paths;

    return StashService.getClient().mutate({
      mutation: PluginApi.GQL.RunPluginTaskDocument,
      variables: { plugin_id: PLUGIN_ID, task_name: TASK_NAME, args_map: args },
    });
  }

  function useQueueTask() {
    const intl = useIntl();
    const Toast = PluginApi.hooks.useToast();

    return React.useCallback(
      async (options: IOptions, target: { sceneIds?: string[]; paths?: string[] }) => {
        try {
          await runTask(options, target);
          Toast.success(
            intl.formatMessage(
              { id: "config.tasks.added_job_to_queue" },
              { operation_name: intl.formatMessage({ id: "actions.generate" }) }
            )
          );
        } catch (e) {
          Toast.error(e);
        }
      },
      [intl, Toast]
    );
  }

  /* ------------------------------------------------------------------ *
   * The option rows, shared by the dialog and the tasks page
   * ------------------------------------------------------------------ */

  const FormatSetting: React.FC<{ value: string; onChange: (v: string) => void }> = ({
    value,
    onChange,
  }) => {
    const { Setting } = PluginApi.components;
    return (
      <Setting
        id="vr-format"
        heading="VR format"
        subHeading="Which half of the frame holds one eye. Auto reads it from the filename and leaves a scene alone when the name says nothing; any other choice is applied to every scene in the run. Hover a format to see the filename tokens it is recognised by."
      >
        <Form.Control
          className="input-control"
          as="select"
          value={value}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.currentTarget.value)}
        >
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value} title={f.tokens}>
              {f.label}
            </option>
          ))}
        </Form.Control>
      </Setting>
    );
  };

  /**
   * "Override preview generation options", rebuilt.
   *
   * Stash does this with ModalSetting, which needs a settings context that
   * plugins have no way to provide, and with VideoPreviewInput, which is not
   * exposed either. Both are small enough to just write.
   */
  const PreviewOptionsSetting: React.FC<{
    value?: IPreviewOptions;
    disabled?: boolean;
    onChange: (v: IPreviewOptions) => void;
  }> = ({ value, disabled, onChange }) => {
    const intl = useIntl();
    const { Setting } = PluginApi.components;
    const [draft, setDraft] = React.useState<IPreviewOptions | undefined>(undefined);

    function field(
      id: string,
      headingID: string,
      descriptionID: string,
      control: JSX.Element
    ) {
      return (
        <Form.Group id={id}>
          <h6>{intl.formatMessage({ id: headingID })}</h6>
          {control}
          <Form.Text className="text-muted">
            {intl.formatMessage({ id: descriptionID })}
          </Form.Text>
        </Form.Group>
      );
    }

    function set(v: Partial<IPreviewOptions>) {
      setDraft({ ...(draft ?? {}), ...v });
    }

    const heading = intl.formatMessage({
      id: "dialogs.scene_gen.override_preview_generation_options",
    });

    return (
      <>
        <Setting
          id="vr-preview-options"
          className="sub-setting"
          disabled={disabled}
          heading={heading}
          subHeading={intl.formatMessage({
            id: "dialogs.scene_gen.override_preview_generation_options_desc",
          })}
        >
          <Button disabled={disabled} onClick={() => setDraft(value ?? {})}>
            {intl.formatMessage({ id: "actions.edit" })}
          </Button>
        </Setting>

        {draft !== undefined ? (
          <Modal show onHide={() => setDraft(undefined)}>
            <Modal.Header closeButton>
              <Modal.Title>{heading}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              {field(
                "vr-preview-segments",
                "dialogs.scene_gen.preview_seg_count_head",
                "dialogs.scene_gen.preview_seg_count_desc",
                <Form.Control
                  className="text-input"
                  type="number"
                  min={1}
                  value={draft.previewSegments ?? ""}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    set({ previewSegments: Number.parseInt(e.currentTarget.value || "1", 10) })
                  }
                />
              )}
              {field(
                "vr-preview-segment-duration",
                "dialogs.scene_gen.preview_seg_duration_head",
                "dialogs.scene_gen.preview_seg_duration_desc",
                <Form.Control
                  className="text-input"
                  type="number"
                  value={draft.previewSegmentDuration ?? ""}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    set({
                      previewSegmentDuration: Number.parseFloat(e.currentTarget.value || "0"),
                    })
                  }
                />
              )}
              {field(
                "vr-preview-exclude-start",
                "dialogs.scene_gen.preview_exclude_start_time_head",
                "dialogs.scene_gen.preview_exclude_start_time_desc",
                <Form.Control
                  className="text-input"
                  value={draft.previewExcludeStart ?? ""}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    set({ previewExcludeStart: e.currentTarget.value })
                  }
                />
              )}
              {field(
                "vr-preview-exclude-end",
                "dialogs.scene_gen.preview_exclude_end_time_head",
                "dialogs.scene_gen.preview_exclude_end_time_desc",
                <Form.Control
                  className="text-input"
                  value={draft.previewExcludeEnd ?? ""}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    set({ previewExcludeEnd: e.currentTarget.value })
                  }
                />
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onClick={() => setDraft(undefined)}>
                {intl.formatMessage({ id: "actions.cancel" })}
              </Button>
              <Button
                onClick={() => {
                  onChange(draft);
                  setDraft(undefined);
                }}
              >
                {intl.formatMessage({ id: "actions.confirm" })}
              </Button>
            </Modal.Footer>
          </Modal>
        ) : null}
      </>
    );
  };

  const VrGenerateOptions: React.FC<{
    options: IOptions;
    setOptions: (v: IOptions) => void;
    /** Preview overrides are only offered for a selection, as in Stash. */
    selection?: boolean;
  }> = ({ options, setOptions, selection }) => {
    const { BooleanSetting } = PluginApi.components;

    function set(input: Partial<IOptions>) {
      setOptions({ ...options, ...input });
    }

    // Markers are not implemented yet. The rows are here so that the shape of
    // the dialog does not change when they arrive.
    function pending(id: string, headingID: string, className?: string) {
      return (
        <BooleanSetting
          id={id}
          className={className}
          disabled
          checked={false}
          headingID={headingID}
          subHeading="Not generated by this plugin yet."
          onChange={() => undefined}
        />
      );
    }

    return (
      <>
        <BooleanSetting
          id="vr-covers-task"
          headingID="dialogs.scene_gen.covers"
          checked={options.covers}
          onChange={(v: boolean) => set({ covers: v })}
        />
        <BooleanSetting
          id="vr-preview-task"
          headingID="dialogs.scene_gen.video_previews"
          tooltipID="dialogs.scene_gen.video_previews_tooltip"
          checked={options.previews}
          onChange={(v: boolean) => set({ previews: v })}
        />
        <BooleanSetting
          id="vr-image-preview-task"
          className="sub-setting"
          disabled={!options.previews}
          headingID="dialogs.scene_gen.image_previews"
          tooltipID="dialogs.scene_gen.image_previews_tooltip"
          checked={options.imagePreviews}
          onChange={(v: boolean) => set({ imagePreviews: v })}
        />
        {selection ? (
          <PreviewOptionsSetting
            disabled={!options.previews}
            value={options.previewOptions}
            onChange={(v) => set({ previewOptions: v })}
          />
        ) : null}
        <BooleanSetting
          id="vr-sprite-task"
          headingID="dialogs.scene_gen.sprites"
          tooltipID="dialogs.scene_gen.sprites_tooltip"
          checked={options.sprites}
          onChange={(v: boolean) => set({ sprites: v })}
        />
        {pending("vr-marker-task", "dialogs.scene_gen.markers")}
        {pending("vr-marker-image-preview-task", "dialogs.scene_gen.marker_image_previews", "sub-setting")}
        {pending("vr-marker-screenshot-task", "dialogs.scene_gen.marker_screenshots")}

        <FormatSetting value={options.format} onChange={(v) => set({ format: v })} />

        <BooleanSetting
          id="vr-overwrite"
          headingID="dialogs.scene_gen.overwrite"
          checked={options.overwrite}
          onChange={(v: boolean) => set({ overwrite: v })}
        />
      </>
    );
  };

  /* ------------------------------------------------------------------ *
   * The dialog behind "Generate as VR…"
   * ------------------------------------------------------------------ */

  const GenerateVrDialog: React.FC<{ sceneIds: string[]; onClose: () => void }> = ({
    sceneIds,
    onClose,
  }) => {
    const intl = useIntl();
    const queue = useQueueTask();
    const [options, setOptions] = React.useState<IOptions>(defaultOptions);
    const [running, setRunning] = React.useState(false);

    async function onGenerate() {
      setRunning(true);
      await queue(options, { sceneIds });
      setRunning(false);
      onClose();
    }

    return (
      <Modal show size="lg" onHide={onClose}>
        <Modal.Header closeButton>
          <Modal.Title>{DIALOG_TITLE}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <Form.Group id="vr-selected-ids">
              {intl.formatMessage(
                { id: "config.tasks.generate.generating_scenes" },
                {
                  num: sceneIds.length,
                  scene: intl.formatMessage(
                    { id: "countables.scenes" },
                    { count: sceneIds.length }
                  ),
                }
              )}
              .
            </Form.Group>
            <VrGenerateOptions options={options} setOptions={setOptions} selection />
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onClose}>
            {intl.formatMessage({ id: "actions.cancel" })}
          </Button>
          <Button onClick={onGenerate} disabled={running || nothingSelected(options)}>
            {intl.formatMessage({ id: "actions.generate" })}
          </Button>
        </Modal.Footer>
      </Modal>
    );
  };

  /* ------------------------------------------------------------------ *
   * Walking a rendered tree
   *
   * Neither … menu is a patchable component, but both are built by an ancestor
   * that is, and appear in the element tree it returns before anything renders
   * them. So: find one element in that tree and swap it for a wrapped copy.
   * Both walks run on every render of a large component, so they stay shallow,
   * stop at the first hit, and never throw -- a patch that throws takes the
   * page with it.
   * ------------------------------------------------------------------ */

  const MAX_DEPTH = 24;

  function replaceElement(
    node: any,
    match: (el: any) => any | null,
    depth = 0
  ): { node: any; found: boolean } {
    if (depth > MAX_DEPTH || node === null || node === undefined || typeof node !== "object") {
      return { node, found: false };
    }

    if (Array.isArray(node)) {
      let found = false;
      const next = node.map((child) => {
        if (found) return child;
        const result = replaceElement(child, match, depth + 1);
        found = found || result.found;
        return result.node;
      });
      return found ? { node: next, found } : { node, found: false };
    }

    if (!React.isValidElement(node)) return { node, found: false };

    const replacement = match(node);
    if (replacement) return { node: replacement, found: true };

    const children = (node as any).props?.children;
    const result = replaceElement(children, match, depth + 1);
    if (!result.found) return { node, found: false };
    return {
      node: React.cloneElement(node as any, undefined, result.node),
      found: true,
    };
  }

  function safely<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  /* ------------------------------------------------------------------ *
   * Scene list: "Generate as VR…" under "Generate…"
   * ------------------------------------------------------------------ */

  interface IOperation {
    text: string;
    onClick: () => void;
    isDisplayed?: () => boolean;
    icon?: unknown;
  }

  /**
   * Wraps the ListOperations element with one extra menu entry.
   *
   * A component rather than a plain clone because finding Stash's own
   * "Generate…" entry means formatting the same message it did, which needs
   * useIntl, and because the dialog has to live somewhere that outlives the
   * dropdown closing.
   */
  const SceneListOperations: React.FC<{ element: any; selectedIds: Set<string> }> = ({
    element,
    selectedIds,
  }) => {
    const intl = useIntl();
    const [showing, setShowing] = React.useState(false);

    const ids = React.useMemo(() => Array.from(selectedIds ?? []), [selectedIds]);

    const operations = React.useMemo(() => {
      const existing: IOperation[] = element.props?.operations ?? [];
      const entry: IOperation = {
        text: MENU_LABEL,
        onClick: () => setShowing(true),
        isDisplayed: () => ids.length > 0,
      };

      // Stash builds its entry as `${actions.generate}…`; matching that puts
      // ours directly underneath rather than at the bottom of the menu.
      const generate = `${intl.formatMessage({ id: "actions.generate" })}…`;
      const at = existing.findIndex((o) => o.text === generate);
      const next = existing.slice();
      next.splice(at < 0 ? next.length : at + 1, 0, entry);
      return next;
    }, [element, ids, intl]);

    return (
      <>
        {React.cloneElement(element, { operations })}
        {showing ? (
          <GenerateVrDialog sceneIds={ids} onClose={() => setShowing(false)} />
        ) : null}
      </>
    );
  };

  const SceneListWrapper: React.FC<{ tree: any }> = ({ tree }) =>
    safely(
      () =>
        replaceElement(tree, (el) => {
          // FilteredListToolbar carries both halves of what is needed: the
          // selection, and the element that renders the … menu.
          const props = (el as any).props;
          if (!props?.listSelect || !React.isValidElement(props.operationComponent)) return null;
          return React.cloneElement(el as any, {
            operationComponent: (
              <SceneListOperations
                element={props.operationComponent}
                selectedIds={props.listSelect.selectedIds}
              />
            ),
          });
        }).node,
      tree
    );

  PluginApi.patch.after("FilteredSceneList", (_props: any, _context: any, result: any) =>
    React.createElement(SceneListWrapper, { tree: result })
  );

  /* ------------------------------------------------------------------ *
   * Scene page: the same entry in that scene's … menu
   * ------------------------------------------------------------------ */

  const ScenePageWrapper: React.FC<{ tree: any; sceneId: string }> = ({ tree, sceneId }) => {
    const [showing, setShowing] = React.useState(false);

    const patched = React.useMemo(
      () =>
        safely(
          () =>
            replaceElement(tree, (el) => {
              // The operations Dropdown.Menu, identified by the item Stash
              // gives the key "generate". Keys survive on elements taken
              // straight out of props.children.
              const children = (el as any).props?.children;
              if (!Array.isArray(children)) return null;
              const at = children.findIndex(
                (c: any) => React.isValidElement(c) && (c as any).key === "generate"
              );
              if (at < 0) return null;

              const item = (
                <Dropdown.Item
                  key="inz-vr-generate"
                  className="bg-secondary text-white"
                  onClick={() => setShowing(true)}
                >
                  {MENU_LABEL}
                </Dropdown.Item>
              );
              const next = children.slice();
              next.splice(at + 1, 0, item);
              return React.cloneElement(el as any, undefined, next);
            }).node,
          tree
        ),
      [tree]
    );

    return (
      <>
        {patched}
        {showing ? (
          <GenerateVrDialog sceneIds={[sceneId]} onClose={() => setShowing(false)} />
        ) : null}
      </>
    );
  };

  PluginApi.patch.after("ScenePage", (props: any, _context: any, result: any) => {
    const sceneId = props?.scene?.id;
    if (!sceneId) return result;
    return React.createElement(ScenePageWrapper, { tree: result, sceneId: String(sceneId) });
  });

  /* ------------------------------------------------------------------ *
   * Settings > Tasks > Plugin Tasks
   *
   * The block has to read like the Generated Content section above it: two
   * buttons beside the heading, the switches underneath. SettingGroup takes
   * those as separate props, so the two halves cannot share component state and
   * the options live in a small store instead.
   * ------------------------------------------------------------------ */

  let taskOptions = defaultOptions();
  const subscribers = new Set<() => void>();

  function useTaskOptions(): [IOptions, (v: IOptions) => void] {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      subscribers.add(force);
      return () => {
        subscribers.delete(force);
      };
    }, []);
    return [
      taskOptions,
      (v: IOptions) => {
        taskOptions = v;
        subscribers.forEach((fn) => fn());
      },
    ];
  }

  /** Stash's DirectorySelectionDialog, which is not exposed to plugins. */
  const DirectorySelectionDialog: React.FC<{ onClose: (paths?: string[]) => void }> = ({
    onClose,
  }) => {
    const intl = useIntl();
    const { FolderSelect, Icon } = PluginApi.components;
    const { data } = StashService.useConfiguration();
    const [paths, setPaths] = React.useState<string[]>([]);
    const [current, setCurrent] = React.useState("");

    const libraryPaths = (data?.configuration?.general?.stashes ?? []).map(
      (s: { path: string }) => s.path
    );

    return (
      <Modal show onHide={() => onClose()}>
        <Modal.Header closeButton>
          <Modal.Title>{intl.formatMessage({ id: "actions.select_folders" })}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="dialog-container">
            {paths.map((p) => (
              <Row className="align-items-center mb-1" key={p}>
                <Form.Label column xs={10}>
                  {p}
                </Form.Label>
                <Col xs={2} className="d-flex justify-content-end">
                  <Button
                    className="ml-auto"
                    size="sm"
                    variant="danger"
                    title={intl.formatMessage({ id: "actions.delete" })}
                    onClick={() => setPaths(paths.filter((path) => path !== p))}
                  >
                    <Icon icon={faMinus} />
                  </Button>
                </Col>
              </Row>
            ))}

            <FolderSelect
              currentDirectory={current}
              onChangeDirectory={setCurrent}
              defaultDirectories={libraryPaths}
              appendButton={
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (current && !paths.includes(current)) setPaths(paths.concat(current));
                  }}
                >
                  <Icon icon={faPlus} />
                </Button>
              }
            />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => onClose()}>
            {intl.formatMessage({ id: "actions.cancel" })}
          </Button>
          <Button disabled={paths.length === 0} onClick={() => onClose(paths)}>
            {intl.formatMessage({ id: "actions.confirm" })}
          </Button>
        </Modal.Footer>
      </Modal>
    );
  };

  const VrTaskButtons: React.FC = () => {
    const intl = useIntl();
    const queue = useQueueTask();
    const [options] = useTaskOptions();
    const [choosing, setChoosing] = React.useState(false);
    const disabled = nothingSelected(options);

    return (
      <>
        <Button
          variant="secondary"
          type="submit"
          disabled={disabled}
          onClick={() => queue(options, {})}
        >
          {intl.formatMessage({ id: "actions.generate" })}
        </Button>
        <Button
          variant="secondary"
          type="submit"
          className="mr-2"
          disabled={disabled}
          onClick={() => setChoosing(true)}
        >
          {intl.formatMessage({ id: "actions.selective_generate" })}…
        </Button>
        {choosing ? (
          <DirectorySelectionDialog
            onClose={(paths) => {
              setChoosing(false);
              if (paths) queue(options, { paths });
            }}
          />
        ) : null}
      </>
    );
  };

  const VrTaskOptions: React.FC = () => {
    const [options, setOptions] = useTaskOptions();
    return <VrGenerateOptions options={options} setOptions={setOptions} />;
  };

  // PluginTasks wraps each plugin's tasks in a SettingGroup headed by that
  // plugin's name. Replacing that group's children rather than adding to them
  // is what hides the bare task button the manifest has to declare; setting
  // topLevel is what puts the two buttons beside the heading.
  let pluginName = "VR Generated Content";

  PluginApi.patch.before("SettingGroup", (props: any, context: any) => {
    if (props?.settingProps?.heading !== pluginName) return [props, context];
    return [
      {
        ...props,
        settingProps: {
          ...props.settingProps,
          subHeading: "Generate supporting image, sprite, video, vtt and other files, from one eye of a VR scene.",
        },
        topLevel: React.createElement(VrTaskButtons),
        children: React.createElement(VrTaskOptions),
      },
      context,
    ];
  });

  // The heading is the plugin's display name, so it is asked for rather than
  // assumed -- renaming the plugin should not orphan the block. Until the answer
  // arrives the manifest name stands in.
  StashService.getClient()
    .query({ query: PluginApi.GQL.PluginsDocument })
    .then((result: any) => {
      const found = (result?.data?.plugins ?? []).find((p: any) => p.id === PLUGIN_ID);
      if (found?.name) pluginName = found.name;
    })
    .catch(() => {
      /* the manifest name stands in */
    });
})();
