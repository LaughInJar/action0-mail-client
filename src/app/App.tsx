import { Shell } from "../ui/layout/Shell";
import { AppProviders } from "./AppProviders";
import type { AppServices } from "./services";

/** The application. */
export function App({ services }: { services: AppServices }) {
  return (
    <AppProviders services={services}>
      <Shell />
    </AppProviders>
  );
}
