import { useQueries } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useAiServices } from "../../ai/context";
import type { AiChoice, AiServiceConfig } from "../../ai/types";
import { useT } from "../../i18n/context";
import { useUi } from "../../state/context";
import { Icon } from "../common/Icon";
import { aiModelsKey, serviceLabel, type AiChoiceState } from "./useAi";

interface Option {
  readonly key: string;
  readonly group: string;
  readonly choice: AiChoice;
  readonly label: string;
}

/**
 * The service and model an AI request goes to: a small button that opens
 * a filterable list, the recent choices first, then each service's models
 * (its own list).
 */
export function AiPicker({ choice }: { readonly choice: AiChoiceState }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { service, model } = choice;
  if (!service) return null;
  const label = `${serviceLabel(service, t)} · ${model?.name ?? "…"}`;
  return (
    <div className="relative min-w-0">
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${t.ai.picker}: ${label}`}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="flex max-w-full items-center gap-1 truncate rounded-md px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-black/5 dark:text-zinc-300 dark:hover:bg-white/10 pointer-coarse:min-h-11"
      >
        <span className="truncate">{label}</span>
        <Icon name="chevron-down" className="size-3.5 shrink-0" />
      </button>
      {open && (
        <PickerList
          choice={choice}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function PickerList({
  choice,
  onClose,
}: {
  readonly choice: AiChoiceState;
  readonly onClose: () => void;
}) {
  const t = useT();
  const a = t.ai;
  const ai = useAiServices();
  const services = useUi((state) => state.settings.aiServices);
  const recent = useUi((state) => state.settings.aiRecent);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const results = useQueries({
    queries: services.map((service) => ({
      queryKey: aiModelsKey(service),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        ai.client(service).models(signal),
      staleTime: 60 * 60 * 1000,
      retry: false,
    })),
  });

  // A click outside closes it.
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);

  const byId = new Map(services.map((service) => [service.id, service]));
  const nameOf = (service: AiServiceConfig, modelId: string) =>
    results[services.indexOf(service)]?.data?.find((m) => m.id === modelId)
      ?.name ?? modelId;
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) =>
    words.every((word) => text.toLowerCase().includes(word));
  const options: Option[] = [];
  for (const entry of recent) {
    const service = byId.get(entry.service);
    if (!service) continue;
    const label = `${serviceLabel(service, t)} · ${nameOf(service, entry.model)}`;
    if (matches(label))
      options.push({
        key: `recent:${entry.service}:${entry.model}`,
        group: a.recent,
        choice: entry,
        label,
      });
  }
  const states: { service: AiServiceConfig; state: string | undefined }[] = [];
  services.forEach((service, index) => {
    const group = serviceLabel(service, t);
    const result = results[index];
    const found = (result?.data ?? []).filter((model) =>
      matches(`${group} ${model.name} ${model.id}`),
    );
    for (const model of found)
      options.push({
        key: `${service.id}:${model.id}`,
        group,
        choice: { service: service.id, model: model.id },
        label: model.name,
      });
    states.push({
      service,
      state: result?.isPending
        ? a.loadingModels
        : result?.isError
          ? a.couldntLoadModels
          : undefined,
    });
  });
  const current = Math.min(active, Math.max(0, options.length - 1));
  const pick = (option: Option | undefined) => {
    if (!option) return;
    choice.choose(option.choice);
    onClose();
  };
  const optionId = (index: number) => `${listId}-${String(index)}`;

  return (
    <div
      ref={root}
      className="absolute top-full left-0 z-30 mt-1 flex max-h-80 w-72 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
    >
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the list opens to filter it
        autoFocus
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={
          options.length > 0 ? optionId(current) : undefined
        }
        aria-label={a.filterModels}
        placeholder={a.filterModels}
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setActive(
              Math.max(0, Math.min(options.length - 1, current + delta)),
            );
          } else if (event.key === "Enter") {
            event.preventDefault();
            pick(options[current]);
          } else if (event.key === "Escape") {
            // Only the list closes, not what it's in (the composer).
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        className="border-b border-zinc-200 bg-transparent px-3 py-2 outline-none dark:border-zinc-700 pointer-coarse:min-h-11"
      />
      <div
        id={listId}
        role="listbox"
        aria-label={a.picker}
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {options.map((option, index) => {
          const selected =
            option.choice.service === choice.service?.id &&
            option.choice.model === choice.model?.id;
          const first =
            index === 0 || options[index - 1]?.group !== option.group;
          return (
            <div key={option.key} role="presentation">
              {first && (
                <div
                  role="presentation"
                  className="px-3 pt-2 pb-1 text-xs font-semibold text-zinc-500"
                >
                  {option.group}
                </div>
              )}
              <div
                id={optionId(index)}
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                onPointerMove={() => {
                  setActive(index);
                }}
                onClick={() => {
                  pick(option);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") pick(option);
                }}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 pointer-coarse:min-h-11 ${index === current ? "bg-blue-50 dark:bg-blue-500/15" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected && <Icon name="check" className="size-4 shrink-0" />}
              </div>
            </div>
          );
        })}
        {states
          .filter(({ state }) => state !== undefined)
          .map(({ service, state }) => (
            <li key={service.id} className="px-3 py-1.5 text-xs text-zinc-500">
              {serviceLabel(service, t)}: {state}
            </li>
          ))}
        {options.length === 0 && states.every(({ state }) => !state) && (
          <div role="presentation" className="px-3 py-2 text-xs text-zinc-500">
            {a.noModels}
          </div>
        )}
      </div>
    </div>
  );
}
