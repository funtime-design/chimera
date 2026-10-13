// Persisted identity, not branding. Changing this suffix requires a data/auth migration.
export const CLOUD_SUFFIX = '-cloud';
export const CLOUD_PARENT_LIKE = `%${CLOUD_SUFFIX}`;
export const cloudMember = (person: string): string => `${person}${CLOUD_SUFFIX}`;
// Routing historically tests the tail; authorization requires the first segment to be the person.
export const cloudParentOf = (name: string): string | null => name.endsWith(CLOUD_SUFFIX) ? name.slice(0, -CLOUD_SUFFIX.length) : null;
const cloudPattern = new RegExp(`^[^-]+${CLOUD_SUFFIX}(-|$)`);
const cloudAnywherePattern = new RegExp(`${CLOUD_SUFFIX}(-|$)`);
export function isCloud(name: string, anywhere = false): boolean {
  return (anywhere ? cloudAnywherePattern : cloudPattern).test(name);
}
const cloudParentPattern = new RegExp(`^[^-]+${CLOUD_SUFFIX}$`);
export const isCloudParent = (name: string): boolean => cloudParentPattern.test(name);
