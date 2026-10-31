import { cancel, isCancel, note, select } from '@clack/prompts';
import { desktopIssue, desktopMessages } from './desktop/errors.js';
import { permissionNameSchema, permissionReportSchema, permissionVerificationSchema,
  type PermissionAccess, type PermissionName, type PermissionVerification } from './desktop/permissions.js';

const names: Record<PermissionName, string> = { microphone: 'Microphone', accessibility: 'Accessibility', screenCapture: 'Screen Recording' };
const guidance: Record<PermissionName, string> = {
  microphone: 'System Settings → Privacy & Security → Microphone. Enable the app macOS identifies for this launcher/helper. The check records up to three seconds and discards the audio locally.',
  accessibility: 'System Settings → Privacy & Security → Accessibility. Enable the launcher or helper shown by macOS; use + if needed. The check reads the focused window’s role, without reading its title or selection, changing focus, or issuing input.',
  screenCapture: 'System Settings → Privacy & Security → Screen & System Audio Recording (Screen Recording on some versions). Enable screen recording for the app macOS identifies. The check captures one screen image and discards it inside the helper; it records no system audio.',
};
const outcomes: Record<PermissionVerification['outcome'], string> = {
  verified: 'The local operation succeeded. This verifies access, not model accuracy or permission to execute a user request.',
  'permission-required': 'Access is not granted to this process. Update the matching Privacy & Security entry. If already enabled, fully quit and reopen the launching app, then rerun opensaysme setup.',
  restricted: 'macOS reports restricted access. Review device management or administrator restrictions; repeating the check will not override them.',
  'not-determined': 'The permission request has not completed. Finish the macOS prompt, then recheck access status.',
  unsupported: 'This operation is unsupported. Screen capture and macOS v1 require macOS 14 or later.',
  'no-device': 'No usable microphone audio was observed. Check the selected input device and its availability; a granted permission alone does not prove capture works.',
  'no-window': 'No accessible focused window was available. Open an ordinary application window and try again; this does not establish a permission denial.',
  'capture-failed': 'The operation failed after access was checked. Run opensaysme doctor and check the device/desktop session; this is not proof that permission was denied.',
  cancelled: 'The local check was cancelled. No success is recorded.',
  timeout: 'The local check timed out. Finish any permission prompt, check the desktop session, and try again when ready.',
};
const safe = (value: string) => JSON.stringify(value).slice(1, -1);
const failureText = (error: unknown) => {
  const issue = desktopIssue(error);
  return issue ? desktopMessages[issue]
    : 'The permission helper could not return a valid result. Run npm run build:native, then rerun opensaysme setup from the same terminal.';
};

/** Only explicit verification selections can prompt or capture; status reads are passive. */
export async function setupPermissions(access: PermissionAccess, signal?: AbortSignal): Promise<void> {
  note('Microphone, Accessibility, and Screen Recording are separate macOS grants.\n'
    + 'Choose a local check below to request access if needed and verify that operation.\n'
    + 'Audio/images are discarded inside the helper; nothing is saved or sent to a provider.\n'
    + 'OS grants allow access, but desktop actions still require your spoken request.', 'macOS permissions');
  const checked = new Map<PermissionName, string>();
  let previous: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    let report;
    try { report = permissionReportSchema.parse(await access.inspect(signal)); }
    catch (error) {
      signal?.throwIfAborted(); note(failureText(error), 'Permission status unavailable'); return;
    }
    signal?.throwIfAborted();
    const identity = JSON.stringify([report.helperPath, report.bundleIdentifier, report.launcher]);
    if (identity !== previous) {
      checked.clear(); previous = identity;
      const launcher = report.launcher;
      note(`Helper: ${safe(report.helperPath)}\nHelper identifier: ${safe(report.bundleIdentifier)}\n`
        + (launcher ? `Observed launching app: ${safe(launcher.name)}${launcher.bundleIdentifier ? ` (${safe(launcher.bundleIdentifier)})` : ''}\n`
          + (launcher.path ? `App path: ${safe(launcher.path)}\n` : '') : 'The launching app could not be identified.\n')
        + 'macOS may attribute a grant to the launcher or the helper; this observation does not determine which entry macOS uses.\n'
        + 'After changing grants, fully quit/reopen that launching app if access is still unavailable.\n'
        + 'Moving/rebuilding an unsigned helper can require renewed grants. Rerun setup from the same launcher; provider settings are retained.', 'Permission identity and recovery');
    }
    for (const permission of permissionNameSchema.options) {
      if (report.permissions[permission] !== 'granted') checked.delete(permission);
    }
    note(permissionNameSchema.options.map((permission) => `${names[permission]}: ${report.permissions[permission]}`
      + (checked.has(permission) ? ` — ${checked.get(permission)}` : ' — not verified in this setup session')).join('\n')
      + (report.desktopAvailable ? '' : '\nNo interactive desktop was detected. Run setup from the logged-in macOS desktop.'), 'Current access');
    const selected = await select({ signal, message: 'Choose a local check or finish setup',
      initialValue: 'done',
      options: [
        { value: 'microphone', label: 'Request/verify Microphone', hint: 'may prompt; records up to 3 seconds locally' },
        { value: 'accessibility', label: 'Request/verify Accessibility', hint: 'may prompt; reads focused window role only' },
        { value: 'screenCapture', label: 'Request/verify Screen Recording', hint: 'may prompt; captures and discards one image' },
        { value: 'recheck', label: 'Recheck access status', hint: 'no prompt or capture' },
        { value: 'done', label: 'Finish setup', hint: 'leave unchecked permissions unverified' },
      ],
    });
    if (isCancel(selected)) {
      cancel('Permission checks cancelled. Any saved provider configuration is unchanged.');
      throw new Error('Permission checks cancelled. Any saved provider configuration is unchanged.');
    }
    signal?.throwIfAborted();
    if (selected === 'done') return;
    if (selected === 'recheck') continue;
    const permission = permissionNameSchema.parse(selected);
    checked.delete(permission);
    note(guidance[permission], names[permission]);
    try {
      const result = permissionVerificationSchema.parse(await access.verify(permission, signal));
      signal?.throwIfAborted();
      if (result.permission !== permission) throw new Error('Mismatched verification result.');
      if (result.outcome === 'verified') checked.set(permission, 'local check passed');
      note(outcomes[result.outcome], `${names[permission]}: ${result.outcome}`);
    } catch (error) {
      signal?.throwIfAborted(); note(failureText(error), `${names[permission]} check failed`);
    }
  }
}
