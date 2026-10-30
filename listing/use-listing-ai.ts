"use client";

import type { GenerateListingFromPhotoResponse } from "@nolie/schemas/ai/listing-extraction";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebounce } from "use-debounce";
import { useGenerateListingFromPhotos } from "./use-generate-listing-from-photos";

const DEBOUNCE_MS = 1500;

type Field = "title" | "description";

interface FlagMap {
	title: boolean;
	description: boolean;
}

interface PendingMap {
	title: string | null;
	description: string | null;
}

export type AiState = "idle" | "loading" | "ready" | "failed";

export interface ListingAiApi {
	state: AiState;
	/** Last successfully-applied/displayed result, if any. */
	result: GenerateListingFromPhotoResponse | null;
	/** Number of images used for the displayed result (for the provenance pill). */
	resultImageCount: number;
	/** Suggested updates from a re-run that haven't been applied yet. */
	pending: PendingMap;
	applied: FlagMap;
	dirty: FlagMap;

	titleValue: string;
	descriptionValue: string;

	onTitleChange: (value: string) => void;
	onDescriptionChange: (value: string) => void;

	apply: (field: Field) => void;
	dismiss: (field: Field) => void;
	clearField: (field: Field) => void;
	/** True while a request is in flight (initial OR refetch). */
	isFetching: boolean;
}

interface UseListingAiArgs {
	imageKeys: string[];
	/** Wizard-session id (NL-349) — forwarded to the generation request. */
	sessionId?: string;
}

function differsMaterially(a: string, b: string): boolean {
	return a.trim().toLowerCase() !== b.trim().toLowerCase();
}

export function useListingAi({
	imageKeys,
	sessionId,
}: UseListingAiArgs): ListingAiApi {
	const [debouncedKeys, debouncedControls] = useDebounce(
		imageKeys,
		DEBOUNCE_MS,
		{
			equalityFn: (a, b) =>
				a.length === b.length && a.every((k, i) => k === b[i]),
		},
	);

	const query = useGenerateListingFromPhotos({
		imageKeys: debouncedKeys,
		sessionId,
	});

	// Controlled input values. Initialized empty; populated when the first
	// successful result arrives (or kept empty on first failure).
	const [titleValue, setTitleValue] = useState("");
	const [descriptionValue, setDescriptionValue] = useState("");

	const [dirty, setDirty] = useState<FlagMap>({
		title: false,
		description: false,
	});
	const [applied, setApplied] = useState<FlagMap>({
		title: false,
		description: false,
	});
	const [pending, setPending] = useState<PendingMap>({
		title: null,
		description: null,
	});

	// Snapshot of the image-count for the *currently displayed* result, used
	// by the provenance pill. Not derived from query.data because that would
	// jump as soon as a new query starts; we want it stable until applied.
	const [resultImageCount, setResultImageCount] = useState(0);
	const [result, setResult] = useState<GenerateListingFromPhotoResponse | null>(
		null,
	);

	// Track the last data we *processed* so we don't re-run the apply logic
	// on every render. Compare by reference — react-query gives us a stable
	// reference per fetch.
	const lastProcessedRef = useRef<GenerateListingFromPhotoResponse | null>(
		null,
	);
	const debouncedKeysCountRef = useRef(0);
	debouncedKeysCountRef.current = debouncedKeys.length;

	// User cleared all photos: reset everything immediately. Skip the debounce
	// so the reveal collapses without the 1.5s tail, and wipe stored copy so
	// the next upload starts clean instead of carrying yesterday's title.
	useEffect(() => {
		if (imageKeys.length > 0) return;
		debouncedControls.flush();
		setResult(null);
		setResultImageCount(0);
		setTitleValue("");
		setDescriptionValue("");
		setApplied({ title: false, description: false });
		setDirty({ title: false, description: false });
		setPending({ title: null, description: null });
		lastProcessedRef.current = null;
	}, [imageKeys.length, debouncedControls]);

	useEffect(() => {
		const data = query.data;
		if (!data || data === lastProcessedRef.current) return;
		lastProcessedRef.current = data;

		const isFirstResult = result === null;
		const imageCount = debouncedKeysCountRef.current;

		if (isFirstResult) {
			setResult(data);
			setResultImageCount(imageCount);
			setTitleValue(data.title);
			setDescriptionValue(data.description);
			setApplied({ title: true, description: true });
			setDirty({ title: false, description: false });
			setPending({ title: null, description: null });
			return;
		}

		// Subsequent re-run (e.g. seller swapped the hero photo): clean fields
		// auto-apply; dirty fields stash as pending suggestions so we don't
		// stomp the seller's edits — that's where the chip earns its keep.
		setResult(data);
		setResultImageCount(imageCount);

		const titleChanged = differsMaterially(data.title, titleValue);
		const descChanged = differsMaterially(data.description, descriptionValue);
		const nextPending: PendingMap = { title: null, description: null };

		if (titleChanged) {
			if (dirty.title) nextPending.title = data.title;
			else {
				setTitleValue(data.title);
				setApplied((a) => ({ ...a, title: true }));
			}
		}
		if (descChanged) {
			if (dirty.description) nextPending.description = data.description;
			else {
				setDescriptionValue(data.description);
				setApplied((a) => ({ ...a, description: true }));
			}
		}
		setPending(nextPending);
	}, [query.data, result, titleValue, descriptionValue, dirty]);

	const state: AiState = useMemo(() => {
		if (debouncedKeys.length === 0 && imageKeys.length === 0) return "idle";
		if (query.isFetching && !result) return "loading";
		if (query.isError && !result) return "failed";
		if (result) return "ready";
		// Debounce window before first fetch: behave like loading so the reveal
		// stays open and shimmers.
		return "loading";
	}, [
		debouncedKeys.length,
		imageKeys.length,
		query.isFetching,
		query.isError,
		result,
	]);

	const onTitleChange = useCallback((value: string) => {
		setTitleValue(value);
		setDirty((d) => (d.title ? d : { ...d, title: true }));
		setApplied((a) => (a.title ? { ...a, title: false } : a));
	}, []);

	const onDescriptionChange = useCallback((value: string) => {
		setDescriptionValue(value);
		setDirty((d) => (d.description ? d : { ...d, description: true }));
		setApplied((a) => (a.description ? { ...a, description: false } : a));
	}, []);

	const apply = useCallback((field: Field) => {
		setPending((p) => {
			const next = p[field];
			if (next === null) return p;
			if (field === "title") setTitleValue(next);
			else setDescriptionValue(next);
			setApplied((a) => ({ ...a, [field]: true }));
			setDirty((d) => ({ ...d, [field]: false }));
			return { ...p, [field]: null };
		});
	}, []);

	const dismiss = useCallback((field: Field) => {
		setPending((p) => (p[field] === null ? p : { ...p, [field]: null }));
	}, []);

	const clearField = useCallback((field: Field) => {
		if (field === "title") setTitleValue("");
		else setDescriptionValue("");
		setApplied((a) => ({ ...a, [field]: false }));
		setDirty((d) => ({ ...d, [field]: true }));
		setPending((p) => ({ ...p, [field]: null }));
	}, []);

	return {
		state,
		result,
		resultImageCount,
		pending,
		applied,
		dirty,
		titleValue,
		descriptionValue,
		onTitleChange,
		onDescriptionChange,
		apply,
		dismiss,
		clearField,
		isFetching: query.isFetching,
	};
}
