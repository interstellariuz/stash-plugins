/** "Import from records…" in the scene, gallery and list … menus. */

import { Bootstrap, React, useIntl } from "../../shared/stash";
import { insertAfterKey, insertOperation, replaceListMenu, safely } from "../../shared/tree";
import { menuText } from "./dialog";
import type { Kind } from "./plan";
import { openImport } from "./store";
import { useText } from "./text";

const { Dropdown } = Bootstrap;

const MenuLabel: React.FC = () => {
  const text = useText();
  return <>{`${text("inzRecords.import")}…`}</>;
};

/** Scene page: an item after "Generate…" in the … menu */
export function patchScenePage(props: any, _context: any, result: any) {
  const sceneId = props?.scene?.id;
  if (!sceneId) return result;
  const item = (
    <Dropdown.Item
      key="inz-records-import"
      className="bg-secondary text-white"
      onClick={() => openImport({ scenes: [String(sceneId)] })}
    >
      <MenuLabel />
    </Dropdown.Item>
  );
  return safely("inzRecords", () => insertAfterKey(result, "generate", item), result);
}

/** Scene and gallery lists: an operation for the selection */
export function patchList(kind: Kind) {
  return (_props: any, _context: any, result: any) =>
    safely(
      "inzRecords",
      () =>
        replaceListMenu(result, (menu, selected) => {
          const entry = {
            text: menuText.import,
            onClick: () => {
              const ids = Array.from(selected);
              openImport(kind === "scene" ? { scenes: ids } : { galleries: ids });
            },
            isDisplayed: () => selected.size > 0,
          };
          const operations = insertOperation(menu.props?.operations ?? [], entry, menuText.generate);
          return React.cloneElement(menu, { operations });
        }),
      result
    );
}

/*
 * Gallery page: the header menu is not patchable, so the item is put into
 * the DOM. Hosted by whichever right-hand panel is mounted (the tab container
 * unmounts the other); both get `gallery` in props.
 *
 * react-bootstrap 1.6 renders the menu on first open, hence the observer.
 * Appending a node React does not own is safe here: it places its own nodes
 * with insertBefore relative to their own siblings.
 */

const GalleryMenuItem: React.FC<{ galleryId: string }> = ({ galleryId }) => {
  const text = useText();
  const intl = useIntl();

  React.useEffect(() => {
    const generate = `${intl.formatMessage({ id: "actions.generate" })}…`;
    const label = `${text("inzRecords.import")}…`;
    let inserted: HTMLElement | null = null;
    let warned = false;

    const place = () => {
      const toggle = document.getElementById("operation-menu");
      const menu = toggle?.parentElement?.querySelector(":scope > .dropdown-menu");
      if (!toggle || !menu || menu.querySelector("[data-inz-records]")) return;

      const anchor = Array.from(menu.children).find((c) => c.textContent === generate);
      if (!anchor) {
        if (!warned) console.warn("inzRecords: no Generate… item in the gallery menu; entry not added");
        warned = true;
        return;
      }

      const item = document.createElement("a");
      item.className = "dropdown-item bg-secondary text-white";
      item.href = "#";
      item.setAttribute("role", "button");
      item.dataset.inzRecords = "1";
      item.textContent = label;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        toggle.click(); // closes the menu
        openImport({ galleries: [galleryId] });
      });
      anchor.after(item);
      inserted = item;
    };

    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true });
    place();
    return () => {
      observer.disconnect();
      inserted?.remove();
    };
  }, [galleryId, intl, text]);

  return null;
};

export function patchGalleryPanel(props: any, _context: any, result: any) {
  const id = props?.gallery?.id;
  if (!id) return result;
  return (
    <>
      {result}
      <GalleryMenuItem galleryId={String(id)} />
    </>
  );
}
