import { createContext, useContext } from "react";
import type { Platform } from "./types";
import { webPlatform } from "./web";

/** The platform the app runs on (the web app unless provided otherwise). */
export const PlatformContext = createContext<Platform>(webPlatform);

/** The platform the app runs on. */
export function usePlatform(): Platform {
  return useContext(PlatformContext);
}
