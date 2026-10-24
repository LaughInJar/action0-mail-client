import { formatRoute, type Route } from "../../state/router";

/** The address of a route in this app, e.g. to open it in a new tab. */
export function routeUrl(route: Route): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}${formatRoute(route)}`;
}
