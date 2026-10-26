import { createContext, useContext } from "react";
import type { AiServices } from "./services";

/** The AI assistant's services (provided by the composition root). */
export const AiServicesContext = createContext<AiServices | null>(null);

/** The AI assistant's services. */
export function useAiServices(): AiServices {
  const services = useContext(AiServicesContext);
  if (!services) throw new Error("AiServicesContext is missing");
  return services;
}
