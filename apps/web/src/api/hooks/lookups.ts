import { useQuery } from '@tanstack/react-query';
import { fetchAll, LOOKUP_PAGES } from '../client';
import { keys } from './base';

/**
 * A lookup that may fail for a role without access: the screens then fall back to ids. Every `.catch(() => [])` of
 * the hooks goes through here, so the policy is one: a lookup never fails the screen that only wants names from it.
 */
export const orEmpty = async <T>(load: Promise<T[]>): Promise<T[]> => load.catch(() => []);

/** The same policy for a lookup that is already a map of names. */
export const orNoNames = async (load: Promise<Map<string, string>>): Promise<Map<string, string>> =>
  load.catch(() => new Map());

/** The teams of the organization. Members of no team may not list them; callers choose whether that fails. */
export const fetchTeams = (signal?: AbortSignal, maxPages = LOOKUP_PAGES) =>
  fetchAll('/teams', undefined, maxPages, signal);

/** Team names by id, for the owner and audience labels. */
export const fetchTeamNames = async (signal?: AbortSignal): Promise<Map<string, string>> =>
  new Map((await fetchTeams(signal)).map((t) => [t.id, t.displayName]));

/** Teams for the audience and owner pickers: id and name. */
export const useTeamOptions = () =>
  useQuery({
    queryKey: [...keys.teams, 'options'],
    queryFn: async ({ signal }) =>
      (await fetchTeams(signal)).map((t) => ({ id: t.id, name: t.displayName })),
  });
