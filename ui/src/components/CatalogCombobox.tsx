import { ChevronDown } from "lucide-react";
import type { CSSProperties, MutableRefObject, Ref } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export type CatalogComboboxOption<T> = {
  key: string;
  value: string;
  label: string;
  subtitle?: string | null;
  meta?: string | null;
  searchTerms?: string[];
  metaChips?: Array<{
    key: string;
    label: string;
    tone?: "neutral" | "info" | "warning" | "danger";
  }>;
  disabled?: boolean;
  data: T;
};

function normalizeCatalogSearchText(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·・._\-/]+/g, "");
}

export function CatalogCombobox<T>({
  value,
  options,
  placeholder,
  ariaLabel,
  disabled = false,
  maxVisible = 10,
  inputRef,
  onInput,
  onCommit,
  onCommitInput,
  onBackspaceEmpty,
}: {
  value: string;
  options: Array<CatalogComboboxOption<T>>;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  maxVisible?: number;
  inputRef?: Ref<HTMLInputElement>;
  onInput: (value: string) => void;
  onCommit: (option: CatalogComboboxOption<T>) => void;
  onCommitInput?: (value: string) => void;
  onBackspaceEmpty?: () => void;
}) {
  const listboxId = useId();
  const localInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [composing, setComposing] = useState(false);
  const [filtering, setFiltering] = useState(false);

  const setRefs = (node: HTMLInputElement | null) => {
    localInputRef.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef && "current" in inputRef) {
      (inputRef as MutableRefObject<HTMLInputElement | null>).current = node;
    }
  };

  const filtered = useMemo(() => {
    const query = normalizeCatalogSearchText(value.trim());
    return query && filtering
      ? options.filter((option) => normalizeCatalogSearchText([
          option.label,
          option.value,
          option.subtitle || "",
          option.meta || "",
          ...(option.searchTerms || []),
        ].join(" ")).includes(query))
      : options;
  }, [filtering, options, value]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex((current) => {
      if (!filtered.length) return 0;
      return Math.min(current, filtered.length - 1);
    });
  }, [filtered.length, open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const moveActive = (direction: 1 | -1) => {
    if (!filtered.length) return;
    let next = activeIndex;
    for (let attempt = 0; attempt < filtered.length; attempt += 1) {
      next = (next + direction + filtered.length) % filtered.length;
      if (!filtered[next]?.disabled) break;
    }
    setActiveIndex(next);
  };

  const commit = (option?: CatalogComboboxOption<T>) => {
    if (!option || option.disabled) return;
    onCommit(option);
    setFiltering(false);
    setOpen(false);
  };

  return (
    <div className="catalog-combobox" ref={rootRef}>
      <div className="catalog-combobox-control">
        <input
          ref={setRefs}
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && filtered[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined}
          disabled={disabled}
          value={value}
          onChange={(event) => {
            onInput(event.target.value);
            setFiltering(true);
            setOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => setOpen(true)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (!open) {
                setFiltering(false);
                setOpen(true);
                setActiveIndex(0);
              } else {
                moveActive(1);
              }
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) {
                setFiltering(false);
                setOpen(true);
                setActiveIndex(Math.max(0, filtered.length - 1));
              } else {
                moveActive(-1);
              }
              return;
            }
            if (event.key === "Escape") {
              setOpen(false);
              return;
            }
            if (event.key === "Enter" && !composing) {
              if (open) {
                event.preventDefault();
                const option = filtered[activeIndex];
                if (option && !option.disabled) commit(option);
                else if (value.trim() && onCommitInput) {
                  onCommitInput(value.trim());
                  setFiltering(false);
                  setOpen(false);
                }
              }
              return;
            }
            if (event.key === "Backspace" && !value && onBackspaceEmpty) {
              event.preventDefault();
              onBackspaceEmpty();
            }
          }}
          placeholder={placeholder}
        />
        <button
          type="button"
          aria-label={`展开${ariaLabel}候选`}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setFiltering(false);
            setOpen(true);
            setActiveIndex(0);
            localInputRef.current?.focus();
          }}
          title="展开候选"
        >
          <ChevronDown size={13} />
        </button>
      </div>
      {open && (
        <div
          className="catalog-combobox-list"
          id={listboxId}
          role="listbox"
          style={{ "--catalog-visible-rows": Math.max(4, maxVisible) } as CSSProperties}
        >
          {filtered.length ? filtered.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={option.disabled || undefined}
              aria-label={option.meta ? `${option.label}，${option.meta}` : option.label}
              className={index === activeIndex ? "active" : ""}
              id={`${listboxId}-option-${index}`}
              key={option.key}
              disabled={option.disabled}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(option)}
            >
              <span className="catalog-option-copy">
                <span className="catalog-option-label">{option.label}</span>
                {option.subtitle && <span className="catalog-option-subtitle">{option.subtitle}</span>}
              </span>
              {option.metaChips?.length ? (
                <span className="catalog-option-chips" aria-hidden="true">
                  {option.metaChips.map((chip) => (
                    <span className={`catalog-option-chip ${chip.tone || "neutral"}`} key={chip.key}>{chip.label}</span>
                  ))}
                </span>
              ) : null}
            </button>
          )) : (
            <span className="catalog-combobox-empty">没有匹配候选</span>
          )}
        </div>
      )}
    </div>
  );
}
