/** Small pieces the dialog and the records page share. */

import { Bootstrap, React, Router } from "../../shared/stash";
import { entityName, entityPath, type Entity, type Kind } from "./plan";
import type { FoundEntity } from "./status";
import { useStashText, type StashText } from "./text";

const { Form } = Bootstrap;
const { Link } = Router;

/** A checkbox that reports Shift: shiftKey lives on the click, not the change */
export const Check: React.FC<{
  id: string;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (shift: boolean) => void;
}> = ({ id, checked, disabled, title, onChange }) => (
  <Form.Check
    id={`inz-records-${id}`}
    className="inz-records-check"
    checked={checked}
    disabled={disabled}
    title={title}
    onClick={(e: React.MouseEvent) => onChange(e.shiftKey)}
    // no text selection on a Shift range
    onMouseDown={(e: React.MouseEvent) => e.shiftKey && e.preventDefault()}
    onChange={() => undefined}
  />
);

export const kindLabel = (kind: Kind, stash: StashText) =>
  kind === "scene" ? stash("scene", "Scene") : stash("gallery", "Gallery");

/** Kind, id and name, the name opening the entity in a new tab */
export const EntityHead: React.FC<{ entity: Entity; strong?: boolean }> = ({ entity, strong }) => {
  const stash = useStashText();
  const name = entityName(entity);
  return (
    <span>
      {kindLabel(entity.kind, stash)} {entity.id}{" "}
      <Link to={entityPath(entity.kind, entity.id)} target="_blank" rel="noopener noreferrer">
        {strong ? <strong>{name}</strong> : name}
      </Link>
    </span>
  );
};

/** "scene 12 ✓ gallery 7": what a record's files are in Stash */
export const EntityLinks: React.FC<{ found: FoundEntity[] }> = ({ found }) => {
  const stash = useStashText();
  return (
    <>
      {found.map((e) => (
        <Link
          key={`${e.kind}:${e.id}`}
          to={entityPath(e.kind, e.id)}
          className={`inz-records-entity mr-2${e.imported ? " text-success" : ""}`}
        >
          {kindLabel(e.kind, stash).toLowerCase()} {e.id}
          {e.imported ? " ✓" : ""}
        </Link>
      ))}
    </>
  );
};
