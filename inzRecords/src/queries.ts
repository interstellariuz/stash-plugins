/**
 * Every GraphQL document the UI sends. Kept apart as plain strings so
 * scripts/check-graphql.mjs can validate them against the Stash schema.
 */

const SCENE_FIELDS = `
  id title code date details urls
  studio { id name }
  performers { id name }
  tags { id name }
  galleries { id }
  custom_fields
  files { basename }`;

const GALLERY_FIELDS = `
  id title code date details urls
  studio { id name }
  performers { id name }
  tags { id name }
  scenes { id }
  custom_fields
  files { basename }`;

// The admin page only needs to know where a file is and whether it is imported
const NAME_FIELDS = `id urls files { basename }`;

export const QUERIES = {
  RUN_OP: `
    mutation RecordsOp($args: Map) {
      runPluginOperation(plugin_id: "inzRecords", args: $args)
    }`,

  SCENES_BY_ID: `
    query RecordsScenes($ids: [ID!]) {
      findScenes(ids: $ids, filter: { per_page: -1 }) { scenes { ${SCENE_FIELDS} } }
    }`,

  GALLERIES_BY_ID: `
    query RecordsGalleries($ids: [ID!]) {
      findGalleries(ids: $ids, filter: { per_page: -1 }) { galleries { ${GALLERY_FIELDS} } }
    }`,

  SCENES_BY_PATH: `
    query RecordsScenesByPath($path: String!) {
      findScenes(
        scene_filter: { path: { value: $path, modifier: MATCHES_REGEX } }
        filter: { per_page: -1 }
      ) { scenes { ${SCENE_FIELDS} } }
    }`,

  GALLERIES_BY_PATH: `
    query RecordsGalleriesByPath($path: String!) {
      findGalleries(
        gallery_filter: { path: { value: $path, modifier: MATCHES_REGEX } }
        filter: { per_page: -1 }
      ) { galleries { ${GALLERY_FIELDS} } }
    }`,

  SCENE_NAMES_BY_PATH: `
    query RecordsSceneNames($path: String!) {
      findScenes(
        scene_filter: { path: { value: $path, modifier: MATCHES_REGEX } }
        filter: { per_page: -1 }
      ) { scenes { ${NAME_FIELDS} } }
    }`,

  GALLERY_NAMES_BY_PATH: `
    query RecordsGalleryNames($path: String!) {
      findGalleries(
        gallery_filter: { path: { value: $path, modifier: MATCHES_REGEX } }
        filter: { per_page: -1 }
      ) { galleries { ${NAME_FIELDS} } }
    }`,

  DICTIONARIES: `
    query RecordsDictionaries {
      findStudios(filter: { per_page: -1 }) { studios { id name aliases } }
      findTags(filter: { per_page: -1 }) { tags { id name aliases } }
      findPerformers(filter: { per_page: -1 }) { performers { id name alias_list } }
    }`,

  SCENE_UPDATE: `
    mutation RecordsSceneUpdate($input: SceneUpdateInput!) {
      sceneUpdate(input: $input) { id }
    }`,

  GALLERY_UPDATE: `
    mutation RecordsGalleryUpdate($input: GalleryUpdateInput!) {
      galleryUpdate(input: $input) { id }
    }`,

  STUDIO_CREATE: `
    mutation RecordsStudioCreate($input: StudioCreateInput!) {
      studioCreate(input: $input) { id }
    }`,

  TAG_CREATE: `
    mutation RecordsTagCreate($input: TagCreateInput!) {
      tagCreate(input: $input) { id }
    }`,

  PERFORMER_CREATE: `
    mutation RecordsPerformerCreate($input: PerformerCreateInput!) {
      performerCreate(input: $input) { id }
    }`,
};

export type QueryName = keyof typeof QUERIES;
