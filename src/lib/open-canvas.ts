import { claimArrival, switchProject, useProjects } from '../store/projects';

/**
 * Bring a canvas into view from the canvas chrome — a tab, the library, a
 * shortcut — and catch it up on arrival: its subscriptions healed, then the
 * sessions it follows read for what it missed while out of view (the live
 * watcher only follows the canvas in view). Its arrival framed the camera
 * (back where it was left) and is claimed here, so nothing frames it again.
 * False when nothing switched.
 */
export async function openCanvas(id: string): Promise<boolean> {
  if (id === useProjects.getState().activeId) return false;
  await switchProject(id);
  if (useProjects.getState().activeId !== id) return false;
  claimArrival();
  void import('./atlas/canonical').then((m) => m.unsubscribeOrphanedSessions());
  void import('./atlas/live-mirror').then((m) => m.sweepRecentSessions());
  return true;
}
