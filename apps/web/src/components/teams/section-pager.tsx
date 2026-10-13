import { LINK_CLASS } from '../auth/styles.ts';

/**
 * Keyset "Next" and "Back to start" for one manage section: plain links (no script) whose hrefs keep the
 * section fragment. `label` names the section for the accessible names ("Next members").
 */
export function SectionPager({
  label,
  next,
  start,
}: {
  label: string;
  next: string | null;
  start: string | null;
}) {
  if (next === null && start === null) return null;
  return (
    <p className="flex flex-wrap gap-x-4">
      {start === null ? null : (
        <a href={start} aria-label={`Back to start of ${label}`} className={LINK_CLASS}>
          Back to start
        </a>
      )}
      {next === null ? null : (
        <a href={next} aria-label={`Next ${label}`} className={LINK_CLASS}>
          Next
        </a>
      )}
    </p>
  );
}
