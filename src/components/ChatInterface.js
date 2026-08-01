import {
  Award,
  Car,
  Check,
  Copy,
  ExternalLink,
  Pencil,
  RotateCcw,
  Send,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useChat } from "../contexts/ChatContext";
import { parseReport, streamCarAnalysis } from "../utils/claudeApi";
import { generateOrFetch3D, lookupCachedModel, buildModelSlug } from "../utils/model3d";
import { uploadVehicleImages } from "../utils/imageStorage";
import { compressImageFiles } from "../utils/imageCompress";
import { createCostAccumulator, FIXED_COSTS } from "../utils/pricing";
import { decodeVin } from "../utils/vinDecode";
import {
  extractTextFromPDF,
  fileToBase64,
  getDominantColor,
  getMediaType,
} from "../utils/pdfParser";
import {
  canAnonPrompt,
  canPromptFromDoc,
  canUserPrompt,
  incrementAnonUsage,
  incrementUserUsage,
  isAdmin,
} from "../utils/usage";
import ContextModal from "./ContextModal";
import ReportModal from "./ReportModal";
import SellReportModal from "./SellReportModal";
import ModeTabs from "./ModeTabs";
import FindACarPanel from "./FindACarPanel";
import ThinkingPanel from "./ThinkingPanel";
import UploadArea from "./UploadArea";

// ─── Lightweight markdown renderer ────────────────────────────────────────────
function renderMarkdown(text) {
	if (!text) return null;
	const lines = text.split("\n");
	const elements = [];
	let listBuffer = [];
	let listType = null;
	let key = 0;

	const flushList = () => {
		if (listBuffer.length === 0) return;
		const Tag = listType === "ol" ? "ol" : "ul";
		elements.push(
			<Tag
				key={key++}
				className={listType === "ol" ? "list-decimal" : "list-disc"}
				style={{ paddingLeft: "1.3em", margin: "0.3em 0" }}
			>
				{listBuffer.map((item, i) => (
					<li key={i}>{inlineMarkdown(item)}</li>
				))}
			</Tag>,
		);
		listBuffer = [];
		listType = null;
	};

	const inlineMarkdown = (str) => {
		const parts = [];
		let remaining = str;
		let idx = 0;
		const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
		let match;
		let lastIdx = 0;
		while ((match = re.exec(str)) !== null) {
			if (match.index > lastIdx)
				parts.push(<span key={idx++}>{str.slice(lastIdx, match.index)}</span>);
			if (match[0].startsWith("**"))
				parts.push(<strong key={idx++}>{match[2]}</strong>);
			else if (match[0].startsWith("*"))
				parts.push(<em key={idx++}>{match[3]}</em>);
			else if (match[0].startsWith("`"))
				parts.push(<code key={idx++}>{match[4]}</code>);
			lastIdx = match.index + match[0].length;
		}
		if (lastIdx < str.length)
			parts.push(<span key={idx++}>{str.slice(lastIdx)}</span>);
		// eslint-disable-next-line no-unused-vars
		remaining = "";
		return parts.length > 0 ? parts : str;
	};

	for (const line of lines) {
		if (/^### /.test(line)) {
			flushList();
			elements.push(
				<h3 key={key++} style={{ fontWeight: 700, margin: "0.6em 0 0.2em" }}>
					{inlineMarkdown(line.slice(4))}
				</h3>,
			);
		} else if (/^## /.test(line)) {
			flushList();
			elements.push(
				<h2 key={key++} style={{ fontWeight: 700, margin: "0.7em 0 0.25em" }}>
					{inlineMarkdown(line.slice(3))}
				</h2>,
			);
		} else if (/^[-*] /.test(line)) {
			if (listType !== "ul") {
				flushList();
				listType = "ul";
			}
			listBuffer.push(line.slice(2));
		} else if (/^\d+\. /.test(line)) {
			if (listType !== "ol") {
				flushList();
				listType = "ol";
			}
			listBuffer.push(line.replace(/^\d+\. /, ""));
		} else if (line.trim() === "") {
			flushList();
			elements.push(<br key={key++} />);
		} else {
			flushList();
			elements.push(
				<p key={key++} style={{ margin: "0.3em 0" }}>
					{inlineMarkdown(line)}
				</p>,
			);
		}
	}
	flushList();
	return <div className="message-md">{elements}</div>;
}

// ─── Assistant message — hidden while streaming, reveals when complete ────────
function AssistantText({ text, isStreaming }) {
	if (isStreaming || !text) {
		return (
			<span className="flex items-center gap-1.5">
				<span className="typing-dot" />
				<span className="typing-dot" />
				<span className="typing-dot" />
			</span>
		);
	}
	// Animate in when streaming just finished (key changes → remount → CSS animation)
	return (
		<div key="done" className="message-reveal">
			{renderMarkdown(text)}
		</div>
	);
}

// ─── Verdict mini badge for chat bubble ───────────────────────────────────────
function MiniVerdict({ rating }) {
	const cls =
		{
			Great: "verdict-great",
			Good: "verdict-good",
			Fair: "verdict-fair",
			Bad: "verdict-bad",
		}[rating] || "verdict-gray";
	return (
		<span
			className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${cls}`}
		>
			<Award size={11} /> {rating}
		</span>
	);
}

const USER_MSG_COLLAPSE_THRESHOLD = 400;

// Build a sidebar-friendly session title from a parsed report's vehicle
// block — e.g. { year: 2022, make: "AUDI", model: "S7" } → "2022 AUDI S7".
// Returns null if the vehicle block doesn't have enough info to be
// meaningful (in which case we leave the existing title alone).
//
// We deliberately preserve the make/model casing Claude returns. Some
// brands are acronyms (BMW, GMC, VW) where title-casing would mangle
// them; trying to detect those is fragile, so we just trust the input.
// Trim is omitted to keep the sidebar entry short.
function buildSessionTitleFromReport(report) {
  const v = report?.vehicle;
  if (!v) return null;
  const parts = [];
  if (v.year) parts.push(String(v.year));
  if (v.make) parts.push(String(v.make).trim());
  if (v.model) parts.push(String(v.model).trim());
  const title = parts.join(' ').trim();
  return title.length >= 4 ? title : null; // need at least year + something
}

// True when regenerating the assistant response would replay all the same
// inputs the user originally provided. Files (images, PDFs) aren't persisted
// across page reloads, so a session loaded from the sidebar has the file
// names listed but no bytes — regenerating then would silently drop them and
// produce a degraded result. We disable the button in that case.
function canRegenerateFromUserMsg(userMsg) {
	if (!userMsg) return true;
	const files = Array.isArray(userMsg.files) ? userMsg.files : [];
	if (files.length === 0) return true; // text-only message, always reproducible
	const hadPdf = files.some((f) => typeof f === "string" && f.includes("📄"));
	const hadImage = files.some((f) => typeof f === "string" && f.includes("🖼"));
	if (hadPdf && !userMsg._carfaxText) return false;
	if (hadImage && !userMsg._img64) return false;
	return true;
}

// Note: there is intentionally no UI surface for `msg.totalCost`. Per-message
// cost breakdown is persisted to Firestore (users/{uid}/sessions/{sid}/messages/{mid})
// for developer review in the Firebase console only. If you ever want to
// surface it back in the UI, the data shape is { total, items: [...] }.

// ─── Message bubble ────────────────────────────────────────────────────────────
function MessageBubble({
	msg,
	onEdit,
	onCopy,
	onRetry,
	onViewReport,
	onFeedback,
	isLast,
	isAnalyzing,
	canRetry = true,
}) {
	const isUser = msg.role === "user";
	const [hovered, setHovered] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [copied, setCopied] = useState(false);
	const [userExpanded, setUserExpanded] = useState(false);
	const editRef = useRef(null);

	const textContent = msg.text || msg.content || "";
	const cleanText = textContent
		.replace(/<REPORT>[\s\S]*?<\/REPORT>/g, "")
		.replace(/<REPORT>[\s\S]*$/, "") // hide partial <REPORT> block while streaming
		// Strip the legacy "Used images: …" footer Claude sometimes still emits
		// from prompt-cache hits. The UI shows attached photos already, so the
		// line is pure noise.
		.replace(/^\s*Used images:[^\n]*\n?/gim, "")
		.replace(/^\s*Images reviewed:[^\n]*\n?/gim, "")
		// Collapse 3+ consecutive newlines to a single blank-line separator so
		// the model can't leave a giant gap between paragraphs.
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	const startEdit = () => {
		setEditText(cleanText);
		setEditing(true);
		setTimeout(() => editRef.current?.focus(), 50);
	};

	const submitEdit = () => {
		const trimmed = editText.trim();
		if (trimmed && trimmed !== cleanText) onEdit(msg, trimmed);
		setEditing(false);
	};

	const handleCopy = () => {
		navigator.clipboard.writeText(cleanText);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
		onCopy?.();
	};

	return (
		<div
			className={`flex gap-3 mb-4 group ${isUser ? "flex-row-reverse" : "flex-row"}`}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			{!isUser && (
				<div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
					<Car size={14} className="text-white" />
				</div>
			)}

			<div className={`max-w-2xl ${isUser ? "ml-12" : "mr-12"} flex flex-col`}>
				{editing ? (
					<div
						className="rounded-2xl overflow-hidden"
						style={{
							border: "2px solid var(--color-accent)",
							background: "var(--color-surface)",
						}}
					>
						<textarea
							ref={editRef}
							value={editText}
							onChange={(e) => setEditText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									submitEdit();
								}
								if (e.key === "Escape") setEditing(false);
							}}
							className="w-full px-4 pt-3 pb-2 text-sm resize-none outline-none"
							style={{
								background: "transparent",
								color: "var(--color-text)",
								minHeight: 80,
							}}
							rows={3}
						/>
						<div className="flex items-center justify-end gap-2 px-3 pb-3">
							<button
								onClick={() => setEditing(false)}
								className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
								style={{
									border: "1px solid var(--color-border)",
									color: "var(--color-muted)",
								}}
							>
								Cancel
							</button>
							<button
								onClick={submitEdit}
								disabled={!editText.trim()}
								className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-all"
							>
								<Check size={12} /> Send
							</button>
						</div>
					</div>
				) : (
					<div
						className="rounded-2xl px-4 py-3 text-sm leading-relaxed"
						style={{
							background: isUser
								? "var(--color-accent)"
								: "var(--color-surface)",
							border: isUser ? "none" : "1px solid var(--color-border)",
							color: isUser ? "#fff" : "var(--color-text)",
							whiteSpace: isUser ? "pre-wrap" : undefined,
						}}
					>
						{isUser ? (
							<>
								{userExpanded || cleanText.length <= USER_MSG_COLLAPSE_THRESHOLD
									? cleanText
									: cleanText.slice(0, USER_MSG_COLLAPSE_THRESHOLD) + "…"}
								{cleanText.length > USER_MSG_COLLAPSE_THRESHOLD && (
									<button
										onClick={() => setUserExpanded((e) => !e)}
										className="block mt-2 text-xs font-semibold underline opacity-70 hover:opacity-100"
										style={{ color: "inherit" }}
									>
										{userExpanded ? "Show less" : "Show more"}
									</button>
								)}
							</>
						) : (
							<AssistantText text={cleanText} isStreaming={!!msg.isStreaming} />
						)}
					</div>
				)}

				{/* Files indicator. When the user message has in-session image
				    data (msg._attachments with dataUrl), render real 56px thumbnails
				    that open the lightbox on click. History view (loaded from
				    Firestore where bytes are not persisted) falls back to a textual
				    chip. PDFs always show as a textual chip. */}
				{((msg._attachments && msg._attachments.length > 0) ||
					(msg.imageUrls && msg.imageUrls.length > 0) ||
					(msg.files && msg.files.length > 0)) && (() => {
					// Source priority for thumbnails:
					//   1. _attachments (in-session, data URLs) — fastest, fresh upload
					//   2. imageUrls (persisted to Firestore, Storage HTTPS URLs) +
					//      whatever PDF chips exist in `files`
					//   3. files (text-only fallback, e.g. older messages from before
					//      we wrote imageUrls)
					let items;
					if (Array.isArray(msg._attachments) && msg._attachments.length > 0) {
						items = msg._attachments;
					} else if (Array.isArray(msg.imageUrls) && msg.imageUrls.length > 0) {
						items = [];
						// PDFs aren't uploaded; surface them from the textual `files` array.
						for (const f of msg.files || []) {
							if (typeof f === "string" && f.includes("📄")) {
								items.push({
									kind: "pdf",
									name: f.replace(/^[^a-zA-Z0-9]*\s*/, ""),
								});
							}
						}
						for (const u of msg.imageUrls) {
							items.push({ kind: "image", name: u.name, dataUrl: u.url });
						}
					} else {
						items = (msg.files || []).map((f) => ({
							kind: typeof f === "string" && f.includes("📄") ? "pdf" : "image",
							name: typeof f === "string" ? f.replace(/^[^a-zA-Z0-9]*\s*/, "") : "file",
							dataUrl: null,
						}));
					}
					return (
						<div
							className={`flex flex-wrap gap-1.5 mt-2 ${isUser ? "justify-end" : ""}`}
						>
							{items.map((item, i) =>
								item.kind === "image" && item.dataUrl ? (
									<button
										key={i}
										onClick={() => msg._onPreview && msg._onPreview(item.dataUrl)}
										title={item.name}
										aria-label={`Preview ${item.name}`}
										className="rounded-lg overflow-hidden flex-shrink-0 transition-transform hover:scale-105"
										style={{
											width: 56,
											height: 56,
											border: "1px solid var(--color-border)",
											background: "var(--color-bg)",
											padding: 0,
											cursor: "zoom-in",
										}}
									>
										<img
											src={item.dataUrl}
											alt={item.name}
											style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
										/>
									</button>
								) : (
									<span
										key={i}
										className="text-xs px-2 py-1 rounded-lg inline-flex items-center gap-1"
										style={{
											background: "var(--color-bg)",
											border: "1px solid var(--color-border)",
											color: "var(--color-muted)",
										}}
										title={item.name}
									>
										{item.kind === "pdf" ? "📄" : "🖼"}{" "}
										{(item.name || "").replace(/^[^a-zA-Z0-9]*\s*/, "").slice(0, 28)}
									</span>
								),
							)}
						</div>
					);
				})()}

				{/* Thinking panel */}
				{msg.steps && msg.steps.length > 0 && (
					<ThinkingPanel steps={msg.steps} done={!msg.isStreaming} />
				)}

				{/* Compact report badge */}
				{msg.report && !msg.isStreaming && (
					<div className="mt-2 flex items-center gap-2 flex-wrap">
						<MiniVerdict rating={msg.report.verdict?.rating} />
						<button
							onClick={() => onViewReport(msg)}
							className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all hover:opacity-80"
							style={{
								background: "var(--color-surface)",
								border: "1px solid var(--color-border)",
								color: "var(--color-text)",
							}}
						>
							<ExternalLink size={11} /> View Full Report
						</button>
					</div>
				)}

				{/* Cost breakdown is intentionally NOT rendered. The data still
				    persists on every assistant message via persistLastMessage /
				    updateMessage as `totalCost`, and is queryable in the Firebase
				    console at users/{uid}/sessions/{sid}/messages/{mid}. CostBadge
				    is kept exported so it can be re-enabled later if needed. */}

				{/* Action buttons */}
				{!editing && !msg.isStreaming && hovered && (
					<div
						className={`flex items-center gap-1 mt-1.5 ${isUser ? "justify-end" : "justify-start"}`}
					>
						{isUser && (
							<button
								onClick={startEdit}
								title="Edit message"
								className="p-1.5 rounded-lg transition-all hover:opacity-80"
								style={{ color: "rgba(255,255,255,0.6)" }}
							>
								<Pencil size={13} />
							</button>
						)}
						<button
							onClick={handleCopy}
							title="Copy"
							className="p-1.5 rounded-lg transition-all"
							style={{ color: "var(--color-muted)" }}
						>
							{copied ? (
								<Check size={13} style={{ color: "#16a34a" }} />
							) : (
								<Copy size={13} />
							)}
						</button>
						{!isUser && isLast && !isAnalyzing && (
							<button
								onClick={canRetry ? onRetry : undefined}
								disabled={!canRetry}
								title={
									canRetry
										? "Regenerate"
										: "Re-attach files to regenerate — originals weren't preserved across the page reload"
								}
								className="p-1.5 rounded-lg transition-all"
								style={{
									color: "var(--color-muted)",
									opacity: canRetry ? 1 : 0.35,
									cursor: canRetry ? "pointer" : "not-allowed",
								}}
							>
								<RotateCcw size={13} />
							</button>
						)}
						{!isUser && (
							<>
								<button
									onClick={() => onFeedback?.(msg, msg.feedback === "up" ? null : "up")}
									title={msg.feedback === "up" ? "Remove rating" : "Good response"}
									className="p-1.5 rounded-lg transition-all hover:opacity-80"
									style={{
										color: msg.feedback === "up" ? "#16a34a" : "var(--color-muted)",
										background: msg.feedback === "up" ? "rgba(22,163,74,0.12)" : "transparent",
									}}
								>
									<ThumbsUp size={13} fill={msg.feedback === "up" ? "currentColor" : "none"} />
								</button>
								<button
									onClick={() => onFeedback?.(msg, msg.feedback === "down" ? null : "down")}
									title={msg.feedback === "down" ? "Remove rating" : "Bad response"}
									className="p-1.5 rounded-lg transition-all hover:opacity-80"
									style={{
										color: msg.feedback === "down" ? "#dc2626" : "var(--color-muted)",
										background: msg.feedback === "down" ? "rgba(220,38,38,0.12)" : "transparent",
									}}
								>
									<ThumbsDown size={13} fill={msg.feedback === "down" ? "currentColor" : "none"} />
								</button>
							</>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

// Module-level cache of url → { base64, mediaType }. Populated lazily by
// fetchUrlAsBase64 so re-using the same Storage URL across many follow-up
// turns (or after a refresh) doesn't re-download the bytes every time.
const _imageBase64Cache = new Map();

async function fetchUrlAsBase64(url) {
	if (!url) return null;
	if (_imageBase64Cache.has(url)) return _imageBase64Cache.get(url);
	try {
		const res = await fetch(url);
		if (!res.ok) return null;
		const blob = await res.blob();
		const mediaType = blob.type || "image/jpeg";
		const base64 = await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				// strip "data:...;base64," prefix
				const s = String(reader.result || "");
				const i = s.indexOf(",");
				resolve(i >= 0 ? s.slice(i + 1) : s);
			};
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
		const entry = { base64, mediaType };
		_imageBase64Cache.set(url, entry);
		return entry;
	} catch {
		return null;
	}
}

// Walk the message list backwards looking for the most recent user-attached
// CARFAX text and image set. Returns the inputs we'd need to pass back into
// streamCarAnalysis() so a follow-up turn or a refresh-then-followup retains
// the visual + document context. Without this, "what color are the rims?"
// after refresh asks Claude with no images and gets a nonsense answer.
//
// Source priority for images:
//   1. _attachments[i].dataUrl  (in-session, no network)
//   2. imageUrls[i].url         (Firebase Storage; we fetch + base64 once,
//                                cached across calls)
async function collectHistoryAttachments(messages) {
	let carfaxText = "";
	let images = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		if (!carfaxText && typeof m.carfaxText === "string" && m.carfaxText) {
			carfaxText = m.carfaxText;
		}
		if (!carfaxText && typeof m._carfaxText === "string" && m._carfaxText) {
			carfaxText = m._carfaxText;
		}
		if (images.length === 0) {
			if (Array.isArray(m._attachments) && m._attachments.length) {
				const fromAtt = [];
				for (const a of m._attachments) {
					if (a.kind !== "image" || !a.dataUrl) continue;
					const [meta, data] = String(a.dataUrl).split(",");
					const mediaType = (meta.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
					if (data) fromAtt.push({ base64: data, mediaType, name: a.name });
				}
				if (fromAtt.length) images = fromAtt;
			}
			if (images.length === 0 && Array.isArray(m.imageUrls) && m.imageUrls.length) {
				const fetched = await Promise.all(
					m.imageUrls.map(async (u) => {
						const e = await fetchUrlAsBase64(u.url);
						return e ? { base64: e.base64, mediaType: e.mediaType, name: u.name } : null;
					}),
				);
				images = fetched.filter(Boolean);
			}
		}
		// Stop once we've seen a user turn that had any attachment indicator.
		// Earlier turns are by definition older; we don't want to fall through.
		if (
			carfaxText ||
			images.length > 0 ||
			(Array.isArray(m.files) && m.files.length > 0)
		) {
			break;
		}
	}
	return { carfaxText, images };
}

// Convert a userImage entry into { base64, mediaType } that the Tripo3D
// pipeline accepts. Handles both representations of `dataUrl`:
//   - in-session data: URLs (data:image/jpeg;base64,XXXX) → split the prefix
//   - Firebase Storage HTTPS URLs (persisted across refresh) → fetch the
//     blob and re-encode as base64.
// Returns null if conversion failed (corrupt URL, CORS, network).
async function userImageToTripoFormat(img) {
	const url = img?.dataUrl;
	if (!url) return null;
	if (url.startsWith("data:")) {
		const m = /^data:([^;]+);base64,(.+)$/.exec(url);
		if (!m) return null;
		return { base64: m[2], mediaType: m[1] };
	}
	try {
		const r = await fetch(url);
		if (!r.ok) return null;
		const blob = await r.blob();
		const mediaType = blob.type || "image/jpeg";
		const base64 = await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const s = String(reader.result);
				const idx = s.indexOf(",");
				resolve(idx >= 0 ? s.slice(idx + 1) : s);
			};
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
		return { base64, mediaType };
	} catch {
		return null;
	}
}

// ─── Main ChatInterface ────────────────────────────────────────────────────────
export default function ChatInterface({ onShowUpgrade, onShowAuth, compactTriggerRef, onCompactingChange, onReportModalChange }) {
	const { user, userDoc } = useAuth();
	const {
		messages,
		activeSessionId,
		createSession,
		addMessage,
		persistLastMessage,
		updateLastMessage,
		updateMessage,
		setMessages,
		recordFeedback,
		activeMode,
		setActiveMode,
		renameSession,
	} = useChat();
	const [input, setInput] = useState("");
	const [carfaxFile, setCarfaxFile] = useState(null);
	// Multiple images supported. Each entry is a File object. Append/remove
	// via setVehicleImages; runAnalysis flattens to base64+mediaType array
	// before sending to Claude / Tripo3D.
	const [vehicleImages, setVehicleImages] = useState([]);
	// Lightbox preview for clicking on a thumbnail. null when closed.
	const [previewImageUrl, setPreviewImageUrl] = useState(null);
	const [isAnalyzing, setIsAnalyzing] = useState(false);
	const [showContextModal, setShowContextModal] = useState(false);
	const [activeReport, setActiveReport] = useState(null);
	const [showReportModal, setShowReportModal] = useState(false);
	// Report modal presentation: 'sideBySide' (chat stays visible to the
	// left, modal occupies a draggable portion of the viewport on the right)
	// vs 'full' (classic immersive full-screen with backdrop). Default to
	// sideBySide so users can keep answering Claude's clarifying questions
	// without dismissing the report.
	const [reportLayout, setReportLayout] = useState('sideBySide');
	// User-adjustable width for the side-by-side modal, as a percentage of
	// the viewport. Persisted to localStorage so a user's preferred split
	// sticks across sessions. Clamped to [30, 90] on read + resize.
	const [reportWidthPct, setReportWidthPctRaw] = useState(() => {
		try {
			const raw = window.localStorage.getItem('reportWidthPct');
			const n = raw ? parseFloat(raw) : NaN;
			if (Number.isFinite(n) && n >= 30 && n <= 90) return n;
		} catch {}
		return 65;
	});
	// During drag the transition is disabled (so the modal tracks the cursor
	// 1:1 instead of lagging behind). Flipped on by the resize handle.
	const [isResizingReport, setIsResizingReport] = useState(false);
	const setReportWidthPct = (n) => {
		const clamped = Math.max(30, Math.min(90, n));
		setReportWidthPctRaw(clamped);
		try { window.localStorage.setItem('reportWidthPct', String(clamped)); } catch {}
	};
	// Ref-mirrored activeReport so callbacks (openReport, etc.) can read
	// the latest value without depending on activeReport in their dep
	// arrays — that would cause them to be recreated on every render and
	// invalidate the useCallback contracts elsewhere.
	const activeReportRef = useRef(null);
	useEffect(() => {
		activeReportRef.current = activeReport;
	}, [activeReport]);

	// User's 3D-model-provider preference, mirrored to a ref so
	// startRodinJob can read the latest value at call time without
	// becoming dependent on userDoc (which churns on every settings
	// save and would otherwise recreate the callback unnecessarily).
	const modelProviderPrefRef = useRef('auto');
	useEffect(() => {
		modelProviderPrefRef.current = userDoc?.preferences?.modelProvider || 'auto';
	}, [userDoc?.preferences?.modelProvider]);

	// Remember the mode the user was on before flipping into Find so the
	// back button knows where to return. Updates on every mode change
	// EXCEPT when entering find. Defaults to 'buy' so a deep-link directly
	// into find still has somewhere sensible to fall back to.
	const previousModeRef = useRef('buy');
	useEffect(() => {
		if (activeMode !== 'find') previousModeRef.current = activeMode;
	}, [activeMode]);

	// Notify the parent (App.js) whenever the report modal opens or closes
	// so it can auto-collapse the left sidebar — giving the chat ↔ report
	// split the full screen. App.js restores the user's prior sidebar state
	// when the modal closes.
	useEffect(() => {
		if (typeof onReportModalChange === 'function') {
			onReportModalChange(showReportModal);
		}
	}, [showReportModal, onReportModalChange]);

	// Last-known set of user-uploaded vehicle photos for the active session,
	// keyed by sessionId. We push to this every time `runAnalysis` runs with
	// new image attachments, AND read from it on followup turns that don't
	// re-upload (e.g. "It has 15k miles"). This is the single source of truth
	// for "what photos did the user attach to this conversation" so the
	// follow-up's report modal can keep showing them. Bypasses the fragile
	// message-walk and activeReport-ref lookups that broke after state churn.
	const sessionUserImagesRef = useRef({ sessionId: null, images: [] });
	const rodinAbort = useRef(null);
	const bottomRef = useRef(null);
	const textareaRef = useRef(null);

	// "Same vehicle?" identity check for followup turns. Compares by VIN
	// first (most reliable — survives Claude rewording the trim string),
	// then by year+make+model as a fallback when VIN is unknown. Slug is
	// NOT a reliable signal because Claude often varies the trim text turn
	// to turn ("Sportback Quattro Premium Plus 45 TFSI" → "Sportback 3.0T
	// Quattro Premium Plus" for the same exact VIN).
	const isSameVehicleAsActive = useCallback((newVehicle) => {
		const prev = activeReportRef.current?.report?.vehicle;
		if (!newVehicle || !prev) return false;
		const newVin = (newVehicle.vin || "").toUpperCase();
		const prevVin = (prev.vin || "").toUpperCase();
		if (newVin && prevVin && newVin !== "UNKNOWN" && prevVin !== "UNKNOWN") {
			return newVin === prevVin;
		}
		const norm = (s) => String(s || "").trim().toLowerCase();
		return (
			!!newVehicle.year &&
			String(newVehicle.year) === String(prev.year) &&
			!!newVehicle.make &&
			norm(newVehicle.make) === norm(prev.make) &&
			!!newVehicle.model &&
			norm(newVehicle.model) === norm(prev.model)
		);
	}, []);

	// Resolve the "carry-over" context for a freshly-parsed followup report.
	// Returns the user photos, glbUrl, modelStatus, and modelProvider to thread
	// into openReport so the modal keeps showing the SAME car the user has been
	// discussing — without regenerating 3D or losing uploaded photos. Used by
	// BOTH analysis paths (runAnalysis with images, handleSend text-only).
	const resolveFollowupContext = useCallback((newReport, sessionId, newAttachments = []) => {
		const newVehicle = newReport?.vehicle || null;
		const sameVehicle = isSameVehicleAsActive(newVehicle);
		const prev = activeReportRef.current;

		// Photos: prefer this turn's new attachments. If none, inherit from
		// the prior report (same vehicle) → session-ref cache → message
		// walk-back. Slug guard on session-ref prevents cross-vehicle leakage.
		let userImages = (newAttachments || []).filter(
			(a) => a?.kind === "image" && a?.dataUrl,
		);
		const newVin = (newVehicle?.vin || "").toUpperCase();
		if (userImages.length === 0 && sameVehicle && Array.isArray(prev?.userImages) && prev.userImages.length > 0) {
			userImages = prev.userImages;
		}
		if (
			userImages.length === 0 &&
			sessionUserImagesRef.current?.sessionId === sessionId &&
			Array.isArray(sessionUserImagesRef.current.images) &&
			sessionUserImagesRef.current.images.length > 0 &&
			// Allow if the ref has no VIN tag yet, OR if the VIN matches.
			(!sessionUserImagesRef.current.vin || sessionUserImagesRef.current.vin === newVin || sameVehicle)
		) {
			userImages = sessionUserImagesRef.current.images;
		}
		if (userImages.length === 0) {
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i];
				if (m.role === "assistant" && Array.isArray(m._userImages) && m._userImages.length > 0) {
					userImages = m._userImages;
					break;
				}
				if (m.role === "user" && Array.isArray(m._attachments)) {
					const imgs = m._attachments.filter((a) => a.kind === "image" && a.dataUrl);
					if (imgs.length > 0) {
						userImages = imgs;
						break;
					}
				}
				if (m.role === "user" && Array.isArray(m.imageUrls) && m.imageUrls.length > 0) {
					userImages = m.imageUrls.map((u) => ({ kind: "image", name: u.name, dataUrl: u.url }));
					break;
				}
			}
		}

		// Cache for next followup. Tag with VIN (not slug) so trim drift
		// across turns doesn't invalidate the cache.
		if (userImages.length > 0) {
			sessionUserImagesRef.current = {
				sessionId,
				vin: newVin || null,
				images: userImages,
			};
		}

		// 3D model + provider: only inherit when same vehicle. Otherwise
		// the report is about a different car and needs its own 3D.
		const inheritedGlbUrl = sameVehicle ? prev?.glbUrl || null : null;
		const inheritedModelStatus = sameVehicle ? prev?.modelStatus || null : null;
		const inheritedModelProvider = sameVehicle ? prev?.modelProvider || null : null;
		const reuse3DModel = sameVehicle && !!inheritedGlbUrl;

		return {
			sameVehicle,
			userImages,
			inheritedGlbUrl,
			inheritedModelStatus,
			inheritedModelProvider,
			reuse3DModel,
		};
	}, [messages, isSameVehicleAsActive]);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	// Paste image(s) from clipboard. Appends to the current list rather than
	// replacing — the user can paste several screenshots in succession.
	useEffect(() => {
		const handlePaste = (e) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			const pasted = [];
			for (const item of items) {
				if (item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) {
						const ext = item.type.split("/")[1] || "png";
						pasted.push(
							new File([file], `screenshot-${Date.now()}-${pasted.length}.${ext}`, {
								type: item.type,
							}),
						);
					}
				}
			}
			if (pasted.length) {
				setVehicleImages((prev) => [...prev, ...pasted]);
				e.preventDefault();
			}
		};
		window.addEventListener("paste", handlePaste);
		return () => window.removeEventListener("paste", handlePaste);
	}, []);

	useEffect(() => {
		if (carfaxFile && vehicleImages.length > 0 && !isAnalyzing)
			setShowContextModal(true);
	}, [carfaxFile, vehicleImages.length, isAnalyzing]);

	const checkQuota = useCallback(async () => {
		if (!user) return canAnonPrompt();
		if (userDoc) return canPromptFromDoc(userDoc, user.email);
		return canUserPrompt(user.uid, user.email);
	}, [user, userDoc]);

	const consumeQuota = useCallback(async () => {
		if (!user) {
			incrementAnonUsage();
			return;
		}
		if (isAdmin(user.email)) return;
		await incrementUserUsage(user.uid, user.email);
	}, [user]);

	// Extract the first 17-char VIN from any of the given strings, then fetch
	// a ground-truth decode block (Vincario → NHTSA fallback) for prompt
	// injection. Returns null if no VIN found or both decoders failed.
	// Returns { block, source } — source is 'vincario' | 'nhtsa' so callers
	// can attribute paid-API costs correctly. Returns null when no VIN found
	// or both decoders fail.
	const resolveVinDecode = useCallback(async (...sources) => {
		const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/;
		let vin = null;
		for (const s of sources) {
			if (typeof s !== "string") continue;
			const m = s.match(VIN_RE);
			if (m) { vin = m[0]; break; }
		}
		if (!vin) return null;
		try {
			const decoded = await decodeVin(vin);
			if (!decoded?.block) return null;
			return { block: decoded.block, source: decoded.source || 'unknown' };
		} catch {
			return null;
		}
	}, []);

	const buildUserMemory = useCallback(() => {
		if (!userDoc) return "";
		const prefs = userDoc.preferences || {};
		const parts = [];
		if (prefs.preferredBrands?.length)
			parts.push(`Preferred brands: ${prefs.preferredBrands.join(", ")}`);
		if (prefs.budgetRange) parts.push(`Budget: ${prefs.budgetRange}`);
		if (prefs.pastRatings)
			parts.push(`Past deal ratings: ${JSON.stringify(prefs.pastRatings)}`);
		return parts.join("\n");
	}, [userDoc]);

	const openReport = useCallback(
		(
			report,
			vehicleColor,
			vehicleLabel,
			imageBase64 = null,
			imageMediaType = null,
			glbUrl = null,
			modelStatus = null,
			userImages = [], // [{ kind:'image', name, dataUrl }]
			messageId = null, // assistant-message id; needed for post-hoc add-image
			sessionId = null,
			modelProvider = null,
		) => {
			// Replace state cleanly — but PRESERVE the existing glbUrl when
			// the user is reopening the same vehicle they just viewed. Without
			// this preservation, closing + reopening a report (which is a no-op
			// from the user's perspective) was triggering the cache-rehydration
			// path below + the auto-regen fallback, even when the in-memory
			// glbUrl was perfectly valid for the same slug.
			//
			// When the vehicle is DIFFERENT, we still reset to null so the
			// previous car's GLB doesn't render briefly while the new car's
			// 3D is generating — that's the original behavior preserved for
			// the vehicle-switch case.
			const prevActiveReport = activeReportRef.current;
			const prevSlug = prevActiveReport?.report?.vehicle
				? buildModelSlug(prevActiveReport.report.vehicle)
				: null;
			const newSlug = report?.vehicle ? buildModelSlug(report.vehicle) : null;
			const sameVehicle = !!(prevSlug && newSlug && prevSlug === newSlug);
			const effectiveGlbUrl =
				glbUrl || (sameVehicle ? prevActiveReport?.glbUrl : null) || null;
			const effectiveModelStatus =
				modelStatus || (sameVehicle ? prevActiveReport?.modelStatus : null) || null;
			const effectiveModelProvider =
				modelProvider || (sameVehicle ? prevActiveReport?.modelProvider : null) || null;

			setActiveReport({
				report,
				vehicleColor,
				vehicleLabel,
				imageBase64,
				imageMediaType,
				glbUrl: effectiveGlbUrl,
				modelStatus: effectiveModelStatus,
				modelProvider: effectiveModelProvider,
				userImages,
				messageId,
				sessionId,
				// Tag the report with whichever mode the user was in when this
				// report was produced. SellReportModal vs ReportModal renders
				// based on this; defaults to 'buy' for back-compat when an old
				// report (created before this feature) is reopened.
				mode: activeMode,
			});
			setShowReportModal(true);

			// Cache rehydration on history view: when the user re-opens an old
			// report after a page reload, glbUrl isn't in component state and
			// isn't persisted on the message doc — but the trim's GLB lives in
			// R2 + Firestore (models3d/{slug}). One Firestore read tells us if
			// it's ready, in which case we surface it immediately without
			// re-running Tripo3D. Fresh analyses skip this — they have their
			// own startRodinJob path that handles cache hits there.
			//
			// Use the *effective* glbUrl here so reopen-same-vehicle skips
			// the lookup entirely (we already have the model in memory).
			if (!effectiveGlbUrl && report?.vehicle) {
				lookupCachedModel(report.vehicle).then(async (cached) => {
					if (cached?.glbUrl) {
						setActiveReport((prev) =>
							prev
								? {
									...prev,
									glbUrl: cached.glbUrl,
									modelStatus: "CacheHit",
									modelProvider: cached.modelProvider || prev.modelProvider || null,
								}
								: prev,
						);
						return;
					}
					// Cache miss path. Two reasons this happens:
					//   1. Vehicle was never modeled before (first user on this
					//      trim, no images persisted) → leave terminal so the
					//      "+ Add Image of Vehicle" CTA renders.
					//   2. Slug doc exists but the Tripo URL expired (~24h
					//      CloudFront signature) — and we have the user's
					//      original photo cached. Quietly regenerate so the
					//      modal flips from infinite "Generating 3D model…"
					//      into a real, fresh render. New GLB lands in R2
					//      and the cache works again for every future user.
					const haveImage =
						Array.isArray(userImages) && userImages.length > 0;
					const haveVin = !!report?.vehicle?.vin;

					// If we have neither a user image NOR a VIN to fall back
					// to VinAudit, there's no input source for Tripo at all
					// — flip to Failed so the "+ Add Image" CTA renders.
					if (!haveImage && !haveVin) {
						setActiveReport((prev) =>
							prev ? { ...prev, modelStatus: "Failed" } : prev,
						);
						return;
					}

					// If we have a user image, convert it to Tripo's input
					// shape. If we only have a VIN, submit3DJob will handle
					// the VinAudit lookup internally.
					let tripoImg = null;
					if (haveImage) {
						tripoImg = await userImageToTripoFormat(userImages[0]);
						if (!tripoImg && !haveVin) {
							setActiveReport((prev) =>
								prev ? { ...prev, modelStatus: "Failed" } : prev,
							);
							return;
						}
					}

					// Move to a non-terminal status so the existing
					// "Generating 3D model…" overlay is meaningful (a real
					// job is now running underneath it).
					setActiveReport((prev) =>
						prev ? { ...prev, modelStatus: "Pending" } : prev,
					);

					const fn = startRodinJobRef.current;
					if (typeof fn === "function") {
						fn(
							tripoImg?.base64 || null,
							tripoImg?.mediaType || null,
							`${vehicleLabel || "vehicle"} exterior, realistic car`,
							report.vehicle,
							null,
							sessionId || null,
							messageId || null,
							tripoImg ? [tripoImg] : null,
						);
					}
				});
			}
		},
		[activeMode],
	);

	// Hold the latest startRodinJob in a ref so openReport (declared above)
	// can call it without dragging startRodinJob into its deps array —
	// useCallback ordering would otherwise force this whole block above.
	const startRodinJobRef = useRef(null);

	// Kick off 3D pipeline. Trim-cache-first via the asset library:
	//   - If models3d/{slug} is ready in Firestore → instant cache hit, no Tripo cost.
	//   - Else this client claims, generates via Tripo3D, persists to R2.
	//   - Concurrent clients on the same trim wait for the first one's result.
	//
	// Costs accrued here (VinAudit image lookup, Tripo3D generation) are pushed
	// through `cost` and re-persisted to the assistant message via `messageId`,
	// since startRodinJob runs *after* the message has already been saved.
	const startRodinJob = useCallback(
		async (imageBase64, imageMediaType, _prompt, vehicle = null, cost = null, sessionId = null, messageId = null, images = null) => {
			rodinAbort.current?.abort();
			const controller = new AbortController();
			rodinAbort.current = controller;
			const isDev =
				typeof window !== "undefined" && process.env.NODE_ENV !== "production";
			if (isDev) console.log("%c[3d]", "color:#2563eb;font-weight:bold", "startRodinJob fired", { vehicle, imageCount: images?.length || (imageBase64 ? 1 : 0) });
			try {
				const result = await generateOrFetch3D({
					vehicle,
					images: images && images.length ? images : undefined,
					imageBase64,
					imageMediaType,
					vin: vehicle?.vin ?? null,
					// Honors the user's Settings → 3D Model Provider choice.
					// 'auto' falls back to REACT_APP_MODEL_PROVIDER inside
					// generateOrFetch3D's resolveProvider helper.
					providerOverride: modelProviderPrefRef.current,
					onProgress: ({ status }) => {
						if (controller.signal.aborted) return;
						setActiveReport((prev) =>
							prev ? { ...prev, modelStatus: status } : prev,
						);
					},
					onCost: (item) => {
						if (!cost) return;
						cost.add(item.label, item.amount, item.detail);
						const snap = cost.snapshot();
						updateLastMessage((prev) => ({ ...prev, totalCost: snap }));
						if (sessionId && messageId) {
							updateMessage(sessionId, messageId, { totalCost: snap });
						}
					},
					signal: controller.signal,
				});
				if (controller.signal.aborted) {
					if (isDev) console.log("%c[3d]", "color:#dc2626;font-weight:bold", "startRodinJob aborted before result applied");
					return;
				}
				if (isDev) console.log("%c[3d]", "color:#2563eb;font-weight:bold", "startRodinJob got result", result);
				if (result?.glbUrl) {
					// CRITICAL: in production, never hand a raw Tripo CDN URL
					// to the renderer. Tripo's CDN sends no Access-Control-
					// Allow-Origin header, so Three.js's GLTFLoader hits a
					// CORS block when it tries to fetch — and an uncaught
					// fetch throw from inside the Canvas takes the whole
					// React tree down (white screen). In dev we proxy
					// through /dev-glb-proxy so the URL is same-origin and
					// safe; in prod R2 must serve the GLB instead.
					//
					// If we got here in prod with a Tripo URL, R2 is
					// misconfigured (MODELS_PUBLIC_BASE not set). Mark the
					// model as failed instead of rendering — user sees the
					// procedural fallback / "+ Add Image" CTA rather than
					// a crash.
					const isTripoUrl = /tripo3d\.com\//.test(result.glbUrl);
					const isProxied = result.glbUrl.startsWith('/dev-glb-proxy');
					const safeToRender = isProxied || !isTripoUrl;

					if (!safeToRender) {
						console.warn(
							'[3d] Refusing to render raw Tripo URL in production (would CORS-fail). R2 is likely misconfigured — set MODELS_PUBLIC_BASE in Cloudflare Pages env.',
						);
						setActiveReport((prev) =>
							prev ? { ...prev, modelStatus: 'Failed' } : prev,
						);
						updateLastMessage((prev) => ({ ...prev, _modelStatus: 'Failed' }));
					} else {
						setActiveReport((prev) => {
							if (!prev) {
								if (isDev) console.log("%c[3d]", "color:#dc2626;font-weight:bold", "activeReport is null — modal closed before GLB landed; will still stamp on message so reopen works");
								return prev;
							}
							return {
								...prev,
								glbUrl: result.glbUrl,
								modelStatus: "Done",
								modelProvider: result.modelProvider || prev.modelProvider || null,
							};
						});
						// In-memory always: lets close-and-reopen of the modal in the
						// CURRENT session keep showing the GLB without re-fetching.
						updateLastMessage((prev) => ({
							...prev,
							_glbUrl: result.glbUrl,
							_modelStatus: "Done",
							_modelProvider: result.modelProvider || prev._modelProvider || null,
						}));
					}

					// What we persist to Firestore depends on the URL origin:
					//
					//   - R2 URL (production happy path): persist freely. R2 URLs
					//     don't expire and the bucket has CORS configured.
					//
					//   - Tripo CDN URL (dev — no R2 binding): persist the RAW
					//     Tripo URL (the unproxied form so the expiry check
					//     stays meaningful). The display path re-proxies it
					//     through /dev-glb-proxy. Set glbUrlExpiresAt 22h out so
					//     refresh-within-the-day still hits the cache; expired
					//     entries are filtered out on read.
					//
					//   - Tripo URL in PRODUCTION: never persist. That would
					//     mean R2 is misconfigured (MODELS_PUBLIC_BASE missing)
					//     and persisting a no-CORS URL guarantees the modal
					//     hard-errors on refresh.
					// (isTripoUrl + isProxied already computed above for the
					// render-safety check — reuse them here for persistence.)
					const isTripoCdn = isTripoUrl;
					// In dev, result.glbUrl is the proxied form; recover the raw
					// Tripo URL out of it for persistence.
					const rawUrl = isProxied
						? decodeURIComponent(result.glbUrl.split("url=")[1] || "")
						: result.glbUrl;
					const rawIsTripo = /tripo3d\.com\//.test(rawUrl);

					if (rawIsTripo) {
						if (isDev && sessionId && messageId) {
							const patch = {
								glbUrl: rawUrl,
								glbUrlSource: "tripo",
								glbUrlExpiresAt: Date.now() + 22 * 60 * 60 * 1000,
								modelProvider: result.modelProvider || "tripo",
							};
							updateLastMessage((prev) => ({ ...prev, ...patch }));
							updateMessage(sessionId, messageId, patch);
						} else if (!isDev) {
							console.warn(
								"[3d] R2 returned a Tripo URL in production — MODELS_PUBLIC_BASE likely not set. Not persisting.",
								{ sample: result.glbUrl.slice(0, 80) },
							);
						}
					} else if (!isTripoCdn && !isProxied && sessionId && messageId) {
						// R2 URL — production happy path.
						const patch = {
							glbUrl: result.glbUrl,
							glbUrlSource: "r2",
							modelProvider: result.modelProvider || null,
						};
						updateLastMessage((prev) => ({ ...prev, ...patch }));
						updateMessage(sessionId, messageId, patch);
					}
				} else {
					updateLastMessage((prev) => ({
						...prev,
						_modelStatus: "Failed",
					}));
				}
			} catch (err) {
				if (isDev) console.warn("%c[3d]", "color:#dc2626;font-weight:bold", "startRodinJob threw", err);
				// 3D API not configured or failed — procedural fallback stays
			}
		},
		[updateLastMessage, updateMessage],
	);

	// Keep the ref pointed at the latest startRodinJob so the openReport
	// cache-miss path (declared above) can call it without a circular
	// useCallback dependency.
	useEffect(() => {
		startRodinJobRef.current = startRodinJob;
	}, [startRodinJob]);

	// Post-hoc "+ Add Image" flow from inside ReportModal. The user opened a
	// report with no source image (CARFAX-only path, or an old chat where the
	// images expired) and wants a 3D model. We accept a single File, push it
	// through the same Tripo3D pipeline that the live analysis uses, and stamp
	// the new image onto the assistant message so:
	//   - the right sidebar's FilesPanel picks it up immediately
	//   - reopening the report later still has the image to render
	//   - the GLB is persisted to R2 by trim-slug, so future users skip Tripo
	const handleAddImageToReport = useCallback(
		async (file) => {
			if (!file || !activeReport?.report?.vehicle) return;

			// Read the chosen file as both a data URL (for instant preview) and
			// a base64 payload (Tripo input). Tripo accepts data URLs directly
			// but we still need the raw base64 + mediaType for our generator.
			const readDataUrl = () =>
				new Promise((resolve, reject) => {
					const r = new FileReader();
					r.onload = () => resolve(r.result);
					r.onerror = reject;
					r.readAsDataURL(file);
				});
			let dataUrl;
			try {
				dataUrl = await readDataUrl();
			} catch {
				return;
			}
			const mediaType = file.type || 'image/jpeg';
			const base64 = String(dataUrl).split(',')[1] || '';
			const newImage = { kind: 'image', name: file.name || 'vehicle.jpg', dataUrl };

			// 1. Update activeReport state so the modal switches off the CTA
			//    and into the existing "Generating 3D model…" overlay.
			setActiveReport((prev) =>
				prev
					? {
							...prev,
							userImages: [...(prev.userImages || []), newImage],
							modelStatus: 'Pending',
						}
					: prev,
			);

			// 2. Stamp on the assistant message so RightSidebar's FilesPanel
			//    surfaces this image alongside any others. The sidebar already
			//    walks all messages and reads from `_attachments`, so adding
			//    the entry there is enough for in-session display.
			const messageId = activeReport.messageId;
			const sessionId = activeReport.sessionId;
			if (messageId && sessionId) {
				updateMessage(sessionId, messageId, {
					_userImages: [...(activeReport.userImages || []), newImage],
					_attachments: [
						...((Array.isArray(activeReport._attachments) && activeReport._attachments) || []),
						newImage,
					],
				});
			}

			// 3. Background-upload to Firebase Storage so the image survives
			//    refresh. Same pattern as the original analyze flow. We patch
			//    `imageUrls` (Firestore-safe HTTPS URL list) onto the message
			//    once the upload completes; the in-session dataUrl is the
			//    immediate display path until then.
			if (user?.uid && sessionId && messageId) {
				try {
					const uploaded = await uploadVehicleImages(user.uid, sessionId, [file]);
					if (uploaded?.length) {
						updateMessage(sessionId, messageId, {
							imageUrls: [
								...((Array.isArray(activeReport.imageUrls) && activeReport.imageUrls) || []),
								...uploaded,
							],
						});
					}
				} catch (err) {
					console.warn('[3d] post-hoc image upload to Storage failed', err);
				}
			}

			// 4. Run the Tripo3D pipeline. Same call shape as the live path.
			startRodinJob(
				base64,
				mediaType,
				`${activeReport.vehicleLabel || 'vehicle'} exterior, realistic car`,
				activeReport.report.vehicle,
				null,
				sessionId || null,
				messageId || null,
				[{ base64, mediaType }],
			);
		},
		[activeReport, startRodinJob, updateMessage, user],
	);

	const runAnalysis = useCallback(
		async (extraText = "", opts = {}) => {
			// `keepExistingModel`: when true, the 3D pipeline is skipped entirely
			// and the previous report's glbUrl + modelStatus are carried into the
			// new report. Used by "Confirm Edits" / re-analyze flows where the
			// vehicle hasn't changed — only the financing terms — so regenerating
			// the model would be wasted work (it would just slug-cache-hit anyway,
			// but this also avoids a "Generating 3D model…" flash, preserves the
			// user's chosen body color, and saves one Firestore round trip).
			const {
				keepExistingModel = false,
				existingGlbUrl = null,
				existingModelStatus = null,
			} = opts;
			setShowContextModal(false);
			setIsAnalyzing(true);

			const allowed = await checkQuota();
			if (!allowed) {
				setIsAnalyzing(false);
				if (!user) onShowAuth();
				else onShowUpgrade();
				return;
			}

			// Per-analysis cost accumulator. Items get pushed as paid APIs fire
			// (Vincario decode, Claude streaming, VinAudit lookup, Tripo3D job).
			// Final snapshot is persisted on the assistant message; the dev-only
			// CostBadge in MessageBubble reads from there.
			const cost = createCostAccumulator();

			let sessionId = activeSessionId;
			if (!sessionId) sessionId = await createSession("Vehicle Assessment");

			// Compress photos up-front. 1568px JPEG q≈0.82 keeps them well under
			// 300KB each, so 6 photos + carfax stays inside both Anthropic's
			// per-image policy and the Cloudflare Pages function body limit.
			// The originals were causing /api/claude to return 500 on multi-image
			// uploads. Same compressed Files are reused for the in-message
			// _attachments preview AND the Firebase Storage upload, so we do
			// the work once.
			const compressedImages = await compressImageFiles(vehicleImages);

			const userFiles = [];
			if (carfaxFile) userFiles.push(`📄 ${carfaxFile.name}`);
			for (const img of compressedImages) userFiles.push(`🖼 ${img.name}`);

			// Build _attachments — in-session-only structured representation
			// so MessageBubble can render real thumbnails (not just "🖼 name.jpg").
			// PDFs stay as kind:'pdf' chips. Images carry a data URL for preview.
			const userAttachments = [];
			if (carfaxFile) {
				// Carry a data URL on the PDF chip so the sidebar can open it
				// in a new tab (native browser PDF viewer). Only kept in-session;
				// after refresh the dataUrl is gone and the chip becomes a label.
				let pdfDataUrl = null;
				try {
					pdfDataUrl = await new Promise((resolve, reject) => {
						const r = new FileReader();
						r.onload = () => resolve(r.result);
						r.onerror = reject;
						r.readAsDataURL(carfaxFile);
					});
				} catch {
					pdfDataUrl = null;
				}
				userAttachments.push({
					kind: "pdf",
					name: carfaxFile.name,
					dataUrl: pdfDataUrl,
				});
			}
			for (const img of compressedImages) {
				try {
					const dataUrl = await new Promise((resolve, reject) => {
						const r = new FileReader();
						r.onload = () => resolve(r.result);
						r.onerror = reject;
						r.readAsDataURL(img);
					});
					userAttachments.push({ kind: "image", name: img.name, dataUrl });
				} catch {
					userAttachments.push({ kind: "image", name: img.name, dataUrl: null });
				}
			}

			const userText = extraText || input || "Analyze this vehicle deal.";
			setInput("");
			if (textareaRef.current) textareaRef.current.style.height = "";

			// Extract CARFAX text up-front so we can persist it on the user
			// message. Doing it here (rather than in the analyze step below)
			// means follow-up turns can read it from the message history
			// without re-parsing, and refresh-then-follow-up still works.
			let userCarfaxText = "";
			if (carfaxFile) {
				try {
					userCarfaxText = await extractTextFromPDF(carfaxFile);
				} catch {
					userCarfaxText = "";
				}
			}

			const userMessageId = await addMessage(
				sessionId,
				{
					role: "user",
					text: userText,
					files: userFiles,
					// `carfaxText` (no underscore) — persisted to Firestore so
					// follow-up turns / regenerates can re-include the document
					// after a refresh. Typical sizes are 5-15KB; well under the
					// Firestore 1MB-per-doc limit.
					carfaxText: userCarfaxText || null,
					_attachments: userAttachments,
				},
				// Re-analyze prompts ("Re-analyze this deal with these
				// financing terms…") would otherwise clobber the session
				// title set by the first analysis. Skip the title update
				// on re-analyze so the sidebar keeps showing the vehicle name.
				{ skipTitleUpdate: keepExistingModel },
			);

			// Background-upload the vehicle photos to Firebase Storage so they
			// survive a page refresh / chat-switch round-trip. The user message
			// already saved with its in-memory _attachments (data URLs) so the
			// UI is responsive immediately; once the uploads finish we patch
			// `imageUrls` onto the same Firestore doc. If upload fails we leave
			// the message untouched — the next refresh will fall back to the
			// textual chips, same as before this change.
			if (user && userMessageId && compressedImages.length > 0) {
				uploadVehicleImages(user.uid, sessionId, compressedImages)
					.then((uploaded) => {
						if (uploaded.length === 0) return;
						const imageUrls = uploaded.map((u) => ({ url: u.url, name: u.name }));
						updateMessage(sessionId, userMessageId, { imageUrls });
					})
					.catch(() => {});
			}

			const streamMsg = {
				role: "assistant",
				text: "",
				isStreaming: true,
				steps: [],
			};
			await addMessage(sessionId, streamMsg);

			let steps = [];
			const pushStep = (text, status = "running") => {
				steps = [...steps, { text, status }];
				updateLastMessage((prev) => ({ ...prev, steps: [...steps] }));
			};
			const doneStep = (idx, text) => {
				steps = steps.map((s, i) =>
					i === idx ? { ...s, text, status: "done" } : s,
				);
				updateLastMessage((prev) => ({ ...prev, steps: [...steps] }));
			};
			const failStep = (idx, text) => {
				steps = steps.map((s, i) =>
					i === idx ? { ...s, text, status: "error" } : s,
				);
				updateLastMessage((prev) => ({ ...prev, steps: [...steps] }));
			};

			// CARFAX was already extracted up-front (so it could be persisted
			// on the user message). Just surface progress for the user.
			let carfaxText = userCarfaxText || "";
			// Multi-image: array of { base64, mediaType, name } sent to Claude.
			// imageBase64 / imageMediaType remain populated with the FIRST image
			// for back-compat with the rest of the pipeline (Tripo3D, modal preview).
			const processedImages = [];
			let imageBase64 = null;
			let imageMediaType = null;
			let vehicleColorRef = null;

			if (carfaxFile) {
				pushStep(`Reading CARFAX PDF: ${carfaxFile.name}`);
				if (carfaxText) {
					const vinMatch = carfaxText.match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
					doneStep(
						steps.length - 1,
						`CARFAX extracted${vinMatch ? ` · VIN: ${vinMatch[0]}` : ""} · ${Math.round(carfaxText.length / 1000)}k chars`,
					);
				} else {
					carfaxText = "[PDF parsing failed]";
					failStep(
						steps.length - 1,
						"PDF parsing failed — will use manual description",
					);
				}
			}

			if (compressedImages.length > 0) {
				const labelMany = compressedImages.length > 1 ? `${compressedImages.length} images` : compressedImages[0].name;
				pushStep(`Processing ${labelMany}`);
				try {
					for (const file of compressedImages) {
						const b64 = await fileToBase64(file);
						const mt = getMediaType(file);
						processedImages.push({ base64: b64, mediaType: mt, name: file.name });
					}
					// First image is the reference for downstream things that still
					// expect a single image (Tripo3D job, modal preview color sample).
					imageBase64 = processedImages[0]?.base64 || null;
					imageMediaType = processedImages[0]?.mediaType || null;
					vehicleColorRef = await getDominantColor(compressedImages[0]);
					const totalKB = processedImages.reduce(
						(sum, p) => sum + Math.round((p.base64.length * 0.75) / 1024),
						0,
					);
					doneStep(
						steps.length - 1,
						`${processedImages.length} image${processedImages.length > 1 ? "s" : ""} ready · ${totalKB}KB · color sampled`,
					);
				} catch {
					failStep(steps.length - 1, "Image processing failed");
				}
			}

			// Mirror file refs onto the user message in local state so in-session
			// reload/regenerate replays the same inputs. These fields are NOT
			// persisted to Firestore (image bytes are too large; CARFAX text is
			// also kept session-local for symmetry). Once the page reloads or
			// the user opens an old session from the sidebar, the regenerate
			// button is disabled — see canRegenerate() in the render path.
			setMessages((prev) => {
				const copy = [...prev];
				for (let i = copy.length - 1; i >= 0; i--) {
					if (copy[i].role === "user") {
						copy[i] = {
							...copy[i],
							_carfaxText: carfaxText,
							_img64: imageBase64,
							_imgMt: imageMediaType,
						};
						break;
					}
				}
				return copy;
			});

			// Ground-truth VIN decode (Vincario → NHTSA) injected into the prompt
			// so Claude can't hallucinate the wrong trim (e.g. A4 vs S5).
			const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/;
			const vinCandidate =
				carfaxText.match(VIN_RE)?.[0] || userText.match(VIN_RE)?.[0] || null;
			let vinDecodeBlock = null;
			let vinDecodeSource = null;
			if (vinCandidate) {
				pushStep(`Decoding VIN: ${vinCandidate}`);
				const vinResult = await resolveVinDecode(carfaxText, userText);
				if (vinResult) {
					vinDecodeBlock = vinResult.block;
					vinDecodeSource = vinResult.source;
					if (vinDecodeSource === 'vincario') {
						cost.add('Vincario decode', FIXED_COSTS.vincario_decode, 'paid VIN decode');
					}
					// First line of the block is "(source: X)"; second is year make model
					const short = vinDecodeBlock.split("\n")[1] || "decoded";
					doneStep(steps.length - 1, `VIN decoded · ${short}`);
				} else {
					failStep(steps.length - 1, "VIN decode failed — proceeding without");
				}
			}

			pushStep("Connecting to Claude…");
			await consumeQuota();

			let fullText = "";
			try {
				const stream = streamCarAnalysis({
					carfaxText,
					images: processedImages,
					messages: [...messages, { role: "user", text: userText }],
					userMemory: buildUserMemory(),
					vinDecode: vinDecodeBlock,
					mode: activeMode,
				});

				let streamStarted = false;
				let charCount = 0;
				for await (const chunk of stream) {
					if (typeof chunk === "string") {
						if (!streamStarted) {
							doneStep(steps.length - 1, "Connected · streaming response");
							pushStep("Generating deal analysis…");
							streamStarted = true;
						}
						fullText += chunk;
						charCount += chunk.length;
						const _ft = fullText;
						const _cc = charCount;
						if (_cc % 200 < chunk.length) {
							const _prevSteps = steps;
							steps = _prevSteps.map((s, i) =>
								i === _prevSteps.length - 1
									? { ...s, text: `Generating deal analysis… (${_cc} chars)` }
									: s,
							);
							const _steps = steps;
							updateLastMessage((prev) => ({
								...prev,
								text: _ft,
								steps: [..._steps],
							}));
						} else {
							updateLastMessage((prev) => ({ ...prev, text: _ft }));
						}
					} else if (chunk?.type === "usage") {
						// Anthropic message_delta carries token usage at the end of the stream.
						// Translate into priced line items via the accumulator.
						cost.addClaudeUsage(chunk.usage);
					}
				}

				const report = parseReport(fullText);

				if (report) {
					doneStep(
						steps.length - 1,
						`Analysis complete · ${charCount} chars · verdict: ${report.verdict?.rating || "—"}`,
					);
					// Rename the session to the vehicle label so the sidebar
					// shows "2022 AUDI S7" instead of the raw user prompt
					// (VIN, free text, etc.). Idempotent on re-analyze.
					const vehicleTitle = buildSessionTitleFromReport(report);
					if (vehicleTitle && sessionId) {
						renameSession(sessionId, vehicleTitle);
					}
					if (report.vehicle?.vin) {
						pushStep(
							`VIN decoded: ${report.vehicle.vin} → ${report.vehicle.year} ${report.vehicle.make} ${report.vehicle.model}`,
						);
						steps = steps.map((s, i) =>
							i === steps.length - 1 ? { ...s, status: "done" } : s,
						);
					}
				} else {
					doneStep(steps.length - 1, `Response complete · ${charCount} chars`);
				}

				// Snapshot the cost so far (Vincario + Claude). 3D costs are added
				// later by startRodinJob via updateMessage.
				const costSnapshot = cost.snapshot();

				// Store image refs and vehicleColor in message so "View Full Report" works from history
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: fullText,
					report,
					steps: [...steps],
					_img64: imageBase64,
					_imgMt: imageMediaType,
					_vehicleColor: vehicleColorRef,
					totalCost: costSnapshot,
				}));
				const persistedId = await persistLastMessage(sessionId, {
					role: "assistant",
					text: fullText,
					report: report || null,
					_vehicleColor: vehicleColorRef || null,
					totalCost: costSnapshot,
				});

				if (report) {
					const label =
						`${report.vehicle?.year || ""} ${report.vehicle?.make || ""} ${report.vehicle?.model || ""}`.trim();
					const vLabel = label || "Vehicle Assessment";

					// Resolve same-vehicle inheritance via the shared helper —
					// same logic used by handleSend's text-only followup path.
					const ctx = resolveFollowupContext(report, sessionId, userAttachments);
					const userImagesForReport = ctx.userImages;
					// Confirm Edits path forces the prior model to come through
					// even if VIN drift or vehicle change would otherwise miss.
					const inheritedGlbUrl = keepExistingModel
						? existingGlbUrl
						: ctx.inheritedGlbUrl;
					const inheritedModelStatus = keepExistingModel
						? existingModelStatus
						: ctx.inheritedModelStatus;
					const inheritedModelProvider = ctx.inheritedModelProvider;
					const reuse3DModel = keepExistingModel || ctx.reuse3DModel;
					// Stamp the in-session image data + (later) the glbUrl onto the
					// assistant message itself, so closing and re-opening the report
					// preserves both. sanitizeForFirestore strips _-prefixed fields,
					// so this stays in memory only — no Firestore bloat.
					updateLastMessage((prev) => ({
						...prev,
						_userImages: userImagesForReport,
						_vehicleLabel: vLabel,
					}));
					openReport(
						report,
						vehicleColorRef,
						vLabel,
						imageBase64,
						imageMediaType,
						// Preserve the existing 3D model whenever the vehicle hasn't
						// changed — Confirm Edits, clarifying questions, or any
						// follow-up that re-streams the same <REPORT> block. Saves
						// the user a "Generating 3D model…" flash and saves a slug
						// cache lookup or paid provider call.
						inheritedGlbUrl,
						inheritedModelStatus,
						userImagesForReport,
						persistedId || null,
						sessionId || null,
						inheritedModelProvider,
					);
					// When we're reusing an existing 3D model (same-vehicle follow-up
					// or Confirm Edits), persist the inherited URL + provider to
					// Firestore on THIS message. Otherwise startRodinJob would be
					// the only thing that writes glbUrl, and since we just skipped
					// it, a page refresh would land on a message with no glbUrl —
					// which then triggers a fresh 3D generation via lookupCachedModel
					// when the user reopens. (Trim drift across turns means the
					// slug cache often misses on followups.)
					if (reuse3DModel && inheritedGlbUrl && sessionId && persistedId) {
						const isTripoUrlStr = typeof inheritedGlbUrl === "string" && /tripo3d\.com\//.test(inheritedGlbUrl);
						// Replicate's CDN URLs (replicate.delivery/...) are signed
						// with a ~1h TTL — much shorter than Tripo's ~24h. We mark
						// these with a 50-min expiry so the cache doesn't hand
						// back a 404'ing URL on the next reopen.
						const isReplicateUrlStr = typeof inheritedGlbUrl === "string" && /replicate\.delivery\//.test(inheritedGlbUrl);
						const patch = {
							glbUrl: inheritedGlbUrl,
							glbUrlSource: isTripoUrlStr ? "tripo" : isReplicateUrlStr ? "replicate" : "r2",
							modelProvider: inheritedModelProvider || null,
						};
						if (isTripoUrlStr) {
							patch.glbUrlExpiresAt = Date.now() + 22 * 60 * 60 * 1000;
						} else if (isReplicateUrlStr) {
							patch.glbUrlExpiresAt = Date.now() + 50 * 60 * 1000;
						}
						updateLastMessage((prev) => ({ ...prev, ...patch }));
						updateMessage(sessionId, persistedId, patch);
					}
					// Skip the 3D pipeline entirely when we have a usable inherited
					// model. Otherwise kick it off in the background — the cost
					// accumulator + persisted message ID get plumbed through so
					// any VinAudit/Tripo/Replicate costs land on the same message.
					if (!reuse3DModel) {
						const prompt = `${vLabel} exterior, realistic car`;
						startRodinJob(imageBase64, imageMediaType, prompt, report.vehicle, cost, sessionId, persistedId, processedImages);
					}
				}
			} catch (err) {
				failStep(steps.length - 1, `Failed: ${err.message}`);
				const errMsg = err.message.includes("401")
					? "Invalid API key. Please check your .env configuration."
					: `Analysis failed: ${err.message}`;
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: errMsg,
					steps: [...steps],
				}));
				persistLastMessage(sessionId, { role: "assistant", text: errMsg });
			}

			setCarfaxFile(null);
			setVehicleImages([]);
			setIsAnalyzing(false);
		},
		[
			activeSessionId,
			carfaxFile,
			vehicleImages,
			input,
			messages,
			checkQuota,
			consumeQuota,
			createSession,
			addMessage,
			persistLastMessage,
			updateLastMessage,
			updateMessage,
			setMessages,
			user,
			onShowAuth,
			onShowUpgrade,
			buildUserMemory,
			openReport,
			startRodinJob,
			resolveVinDecode,
			activeMode,
			renameSession,
			resolveFollowupContext,
		],
	);

	// /compact — collapse the conversation into a summary so subsequent turns
	// fit comfortably in Claude's context. Replaces the visible message list
	// with a single assistant note containing the summary, keeps the original
	// messages in Firestore (we just stop sending them as context).
	const compactConversation = useCallback(async () => {
		if (isAnalyzing) return;
		const visible = messages.filter(
			(m) => (m.role === "user" || m.role === "assistant") && (m.text || m.content),
		);
		if (visible.length === 0) return;
		onCompactingChange?.(true);
		try {
			const transcript = visible
				.map((m) => `${m.role.toUpperCase()}: ${(m.text || m.content || "").slice(0, 4000)}`)
				.join("\n\n");

			let summary = "";
			const stream = streamCarAnalysis({
				carfaxText: "",
				messages: [
					{
						role: "user",
						text:
							`Summarize this car-deal-analysis conversation into a compact running context. ` +
							`Keep: vehicle (year/make/model/VIN), CARFAX highlights, asking price, financing terms, ` +
							`final verdict + key reasoning, and any user preferences expressed. Drop pleasantries, ` +
							`drop streamed tool steps. Output a single dense paragraph of 6-10 sentences. Do NOT ` +
							`emit a <REPORT> block.\n\n--- TRANSCRIPT ---\n${transcript}`,
					},
				],
				userMemory: buildUserMemory(),
				vinDecode: null,
			});
			for await (const chunk of stream) {
				if (typeof chunk === "string") summary += chunk;
			}
			summary = summary.replace(/<REPORT>[\s\S]*?<\/REPORT>/g, "").trim();
			if (!summary) summary = "(Compaction returned an empty summary; the original conversation is preserved in your session history.)";

			setMessages([
				{
					id: `compact-${Date.now()}`,
					role: "assistant",
					text: `📎 **Conversation compacted** — earlier turns summarized below to free context space.\n\n${summary}`,
					_compacted: true,
				},
			]);
		} catch (err) {
			console.error("compactConversation failed", err);
		} finally {
			onCompactingChange?.(false);
		}
	}, [isAnalyzing, messages, buildUserMemory, setMessages, onCompactingChange]);

	// Expose the compact trigger to App.js so the right sidebar's button can
	// fire it without going through the chat input.
	useEffect(() => {
		if (compactTriggerRef) compactTriggerRef.current = compactConversation;
		return () => {
			if (compactTriggerRef) compactTriggerRef.current = null;
		};
	}, [compactTriggerRef, compactConversation]);

	const handleSend = async () => {
		const text = input.trim();
		if (!text && !carfaxFile && vehicleImages.length === 0) return;
		if (isAnalyzing) return;

		// Slash commands — handled before the regular chat path.
		if (text === "/compact") {
			setInput("");
			if (textareaRef.current) textareaRef.current.style.height = "";
			await compactConversation();
			return;
		}

		if (carfaxFile || vehicleImages.length > 0) {
			await runAnalysis(text);
		} else {
			const allowed = await checkQuota();
			if (!allowed) {
				if (!user) onShowAuth();
				else onShowUpgrade();
				return;
			}

			const cost = createCostAccumulator();

			let sessionId = activeSessionId;
			if (!sessionId) sessionId = await createSession(text.slice(0, 50));
			await addMessage(sessionId, { role: "user", text });
			setInput("");
			if (textareaRef.current) textareaRef.current.style.height = "";
			await consumeQuota();

			const streamMsg = { role: "assistant", text: "", isStreaming: true };
			await addMessage(sessionId, streamMsg);

			// Also decode any VIN in the free-text path so the model gets ground truth.
			const vinResult = await resolveVinDecode(text);
			const vinDecodeBlock = vinResult?.block || null;
			if (vinResult?.source === 'vincario') {
				cost.add('Vincario decode', FIXED_COSTS.vincario_decode, 'paid VIN decode');
			}

			// Re-attach the most recent CARFAX + photos to this follow-up turn
			// so questions like "what color are the rims?" can actually look at
			// the photos. fetchUrlAsBase64 caches per-URL, so the second
			// follow-up doesn't re-download.
			const history = await collectHistoryAttachments(messages);

			let fullText = "";
			try {
				const stream = streamCarAnalysis({
					carfaxText: history.carfaxText || "",
					images: history.images,
					messages: [...messages, { role: "user", text }],
					userMemory: buildUserMemory(),
					mode: activeMode,
					vinDecode: vinDecodeBlock,
				});
				for await (const chunk of stream) {
					if (typeof chunk === "string") {
						fullText += chunk;
						const _ft = fullText;
						updateLastMessage((prev) => ({ ...prev, text: _ft }));
					} else if (chunk?.type === "usage") {
						cost.addClaudeUsage(chunk.usage);
					}
				}
				const report = parseReport(fullText);
				const costSnapshot = cost.snapshot();
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: fullText,
					report,
					totalCost: costSnapshot,
				}));
				const persistedId = await persistLastMessage(sessionId, {
					role: "assistant",
					text: fullText,
					report: report || null,
					totalCost: costSnapshot,
				});
				if (report) {
					const label =
						`${report.vehicle?.year || ""} ${report.vehicle?.make || ""} ${report.vehicle?.model || ""}`.trim();
					const vLabel = label || "Vehicle Assessment";
					// Rename session to vehicle label so the sidebar reflects
					// what this chat is actually about, not the raw user prompt.
					const vehicleTitle = buildSessionTitleFromReport(report);
					if (vehicleTitle && sessionId) {
						renameSession(sessionId, vehicleTitle);
					}
					// Critical: text-only followups MUST inherit the prior report's
					// photos and 3D model when the vehicle is the same. Otherwise
					// the modal opens with no photos AND openReport's cache-miss
					// branch fires startRodinJob, generating a redundant model.
					const ctx = resolveFollowupContext(report, sessionId, []);
					// Stamp the resolved photos onto the assistant message so
					// future followups walk back and find them.
					updateLastMessage((prev) => ({
						...prev,
						_userImages: ctx.userImages,
						_vehicleLabel: vLabel,
					}));
					// Persist the inherited glbUrl + modelProvider to Firestore so
					// after a page refresh the followup message reopens with the
					// SAME 3D model — instead of slug-missing into a fresh job (the
					// followup's slug often drifts from the initial due to Claude
					// rewording the trim).
					if (ctx.inheritedGlbUrl && sessionId && persistedId) {
						const isTripoUrlStr = typeof ctx.inheritedGlbUrl === "string" && /tripo3d\.com\//.test(ctx.inheritedGlbUrl);
						// Replicate signs CDN URLs for ~1h; tag them as such so
						// the read-side knows to treat the cache as stale shortly.
						const isReplicateUrlStr = typeof ctx.inheritedGlbUrl === "string" && /replicate\.delivery\//.test(ctx.inheritedGlbUrl);
						const patch = {
							glbUrl: ctx.inheritedGlbUrl,
							glbUrlSource: isTripoUrlStr ? "tripo" : isReplicateUrlStr ? "replicate" : "r2",
							modelProvider: ctx.inheritedModelProvider || null,
						};
						if (isTripoUrlStr) {
							patch.glbUrlExpiresAt = Date.now() + 22 * 60 * 60 * 1000;
						} else if (isReplicateUrlStr) {
							patch.glbUrlExpiresAt = Date.now() + 50 * 60 * 1000;
						}
						updateLastMessage((prev) => ({ ...prev, ...patch }));
						updateMessage(sessionId, persistedId, patch);
					}
					openReport(
						report,
						null,
						vLabel,
						null,
						null,
						ctx.inheritedGlbUrl,
						ctx.inheritedModelStatus,
						ctx.userImages,
						persistedId || null,
						sessionId || null,
						ctx.inheritedModelProvider,
					);
				}
			} catch (err) {
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: `Error: ${err.message}`,
				}));
				persistLastMessage(sessionId, {
					role: "assistant",
					text: `Error: ${err.message}`,
				});
			}
		}
	};

	const handleEdit = useCallback(
		async (msg, newText) => {
			if (isAnalyzing) return;
			const idx = messages.findIndex((m) => m === msg || m.id === msg.id);
			if (idx === -1) return;

			const truncated = messages.slice(0, idx);
			setMessages(truncated);

			const allowed = await checkQuota();
			if (!allowed) {
				if (!user) onShowAuth();
				else onShowUpgrade();
				return;
			}

			setIsAnalyzing(true);
			const cost = createCostAccumulator();
			let sessionId = activeSessionId;
			if (!sessionId) sessionId = await createSession(newText.slice(0, 50));

			// Preserve original CARFAX/image refs so regenerate re-sends the same inputs.
			// These only exist for messages from the current session — once the page
			// reloads, they're gone, and the regenerate button is disabled upstream
			// to prevent half-input replays. See canRegenerate() in the render path.
			const carfaxText = msg._carfaxText || "";
			const imageBase64 = msg._img64 || null;
			const imageMediaType = msg._imgMt || null;

			await addMessage(sessionId, {
				role: "user",
				text: newText,
				files: msg.files,
				_carfaxText: carfaxText,
				_img64: imageBase64,
				_imgMt: imageMediaType,
			});
			await consumeQuota();

			const streamMsg = { role: "assistant", text: "", isStreaming: true };
			await addMessage(sessionId, streamMsg);

			const vinResult = await resolveVinDecode(carfaxText, newText);
			const vinDecodeBlock = vinResult?.block || null;
			if (vinResult?.source === 'vincario') {
				cost.add('Vincario decode', FIXED_COSTS.vincario_decode, 'paid VIN decode');
			}

			// Pull attachments from the truncated history so a re-analyze still
			// has the visual context, even after a refresh (where in-memory
			// _carfaxText / _img64 are gone but persisted carfaxText / imageUrls
			// remain). The msg object itself is preferred over collectHistory…
			// because edit always re-uses the EDITED message's own attachments.
			let editCarfaxText = carfaxText;
			let editImages = imageBase64 && imageMediaType
				? [{ base64: imageBase64, mediaType: imageMediaType }]
				: [];
			if (!editCarfaxText && typeof msg.carfaxText === "string") editCarfaxText = msg.carfaxText;
			if (editImages.length === 0) {
				const recovered = await collectHistoryAttachments([msg]);
				if (recovered.images.length) editImages = recovered.images;
				if (!editCarfaxText && recovered.carfaxText) editCarfaxText = recovered.carfaxText;
			}

			let fullText = "";
			try {
				const stream = streamCarAnalysis({
					carfaxText: editCarfaxText || "",
					images: editImages,
					messages: [...truncated, { role: "user", text: newText }],
					userMemory: buildUserMemory(),
					vinDecode: vinDecodeBlock,
					mode: activeMode,
				});
				for await (const chunk of stream) {
					if (typeof chunk === "string") {
						fullText += chunk;
						const _ft = fullText;
						updateLastMessage((prev) => ({ ...prev, text: _ft }));
					} else if (chunk?.type === "usage") {
						cost.addClaudeUsage(chunk.usage);
					}
				}
				const report = parseReport(fullText);
				const costSnapshot = cost.snapshot();
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: fullText,
					report,
					totalCost: costSnapshot,
				}));
				persistLastMessage(sessionId, {
					role: "assistant",
					text: fullText,
					report: report || null,
					totalCost: costSnapshot,
				});
				if (report) {
					const label =
						`${report.vehicle?.year || ""} ${report.vehicle?.make || ""} ${report.vehicle?.model || ""}`.trim();
					// Rename session to vehicle label so the sidebar reflects
					// what this chat is actually about, not the raw user prompt.
					const vehicleTitle = buildSessionTitleFromReport(report);
					if (vehicleTitle && sessionId) {
						renameSession(sessionId, vehicleTitle);
					}
					openReport(report, null, label || "Vehicle Assessment");
				}
			} catch (err) {
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: `Error: ${err.message}`,
				}));
				persistLastMessage(sessionId, {
					role: "assistant",
					text: `Error: ${err.message}`,
				});
			}
			setIsAnalyzing(false);
		},
		[
			isAnalyzing,
			messages,
			checkQuota,
			user,
			onShowAuth,
			onShowUpgrade,
			activeSessionId,
			createSession,
			addMessage,
			persistLastMessage,
			consumeQuota,
			buildUserMemory,
			updateLastMessage,
			setMessages,
			openReport,
			resolveVinDecode,
			activeMode,
			renameSession,
		],
	);

	const handleRetry = useCallback(async () => {
		if (isAnalyzing || messages.length < 2) return;
		const lastUser = [...messages].reverse().find((m) => m.role === "user");
		if (!lastUser) return;
		const idx = messages.lastIndexOf(lastUser);
		setMessages(messages.slice(0, idx + 1).slice(0, -1));
		await handleEdit(lastUser, lastUser.text || lastUser.content || "");
	}, [isAnalyzing, messages, handleEdit, setMessages]);

	const handleKey = (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const isEmpty = messages.length === 0;

	// Side-by-side report modal compresses the chat area to the left so the
	// user can keep chatting without dismissing the report. The padding
	// tracks the modal's live width (which the user can drag). When the
	// modal is closed or in full-screen mode, the chat expands back to full
	// width. Transition is disabled mid-drag so the chat edge follows the
	// cursor 1:1.
	const sideModalActive =
		showReportModal && activeReport && activeReport.mode !== 'sell' && reportLayout === 'sideBySide';
	const chatSidePadding = sideModalActive ? `${reportWidthPct}vw` : 0;

	return (
		<div
			className="flex flex-col h-full chat-with-side-modal"
			style={{
				background: "var(--color-bg)",
				paddingRight: chatSidePadding,
				transition: isResizingReport ? 'none' : undefined,
			}}
		>
			{/* Mode tabs — Buy / Sell / Find. Hidden entirely when in Find
			    so the search surface gets the full canvas; the Find panel
			    surfaces its own "Back" affordance for returning to chat. */}
			{activeMode !== 'find' && (
				<div
					className="flex-shrink-0 flex items-center justify-center py-3 px-4"
					style={{ borderBottom: "1px solid var(--color-border)" }}
				>
					<ModeTabs />
				</div>
			)}

			{/* Sliding track: Buy/Sell share the chat panel on the left,
			    Find lives on the right. CSS handles the slide animation
			    based on data-mode. Track height fills the remaining space
			    below ModeTabs. */}
			<div
				className="flex-1 overflow-hidden"
				style={{ position: 'relative' }}
			>
				<div
					className="mode-track"
					data-mode={activeMode === 'find' ? 'find' : 'chat'}
				>
					{/* Chat panel — covers Buy and Sell modes */}
					<div className="flex flex-col h-full">

			{/* Messages */}
			<div className="flex-1 overflow-y-auto px-4 py-6">
				{isEmpty ? (
					<div className="h-full flex flex-col items-center justify-center text-center px-4">
						<div className="w-16 h-16 rounded-3xl bg-blue-600 flex items-center justify-center mb-4 shadow-lg">
							<Car size={28} className="text-white" />
						</div>
						<h1
							className="text-2xl font-bold mb-2"
							style={{ color: "var(--color-text)" }}
						>
							{activeMode === 'sell' ? 'Sell Your Car' : 'VinCritiq'}
						</h1>
						<p
							className="text-base mb-1"
							style={{ color: "var(--color-muted)" }}
						>
							{activeMode === 'sell'
								? 'Find the best price to sell your vehicle'
								: 'AI-powered vehicle deal analysis'}
						</p>
						<p
							className="text-sm max-w-md"
							style={{ color: "var(--color-muted)" }}
						>
							{activeMode === 'sell'
								? "Describe your vehicle (year, make, model, mileage, condition). Add a CARFAX PDF or photos for a more accurate quote. We'll compare prices across private party, trade-in, instant-offer, marketplace, and auction channels."
								: "Upload a CARFAX PDF and/or a vehicle photo to get a professional assessment — pricing, financing, depreciation, and a deal verdict."}
						</p>
						<div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-lg w-full">
							{(activeMode === 'sell'
								? [
										{ title: 'Best Channel', desc: 'Private party / trade-in / instant / marketplace / auction' },
										{ title: 'Improvements', desc: 'High-ROI upgrades before listing' },
										{ title: 'Market Context', desc: 'Demand, days to sell, competition' },
								  ]
								: [
										{ title: 'Deal Rating', desc: 'Great / Good / Fair / Bad classification' },
										{ title: 'Price Analysis', desc: 'vs. KBB & market average' },
										{ title: 'Depreciation', desc: '1, 3, and 5 year projections' },
								  ]
							).map((c) => (
								<div
									key={c.title}
									className="rounded-xl p-3 text-left"
									style={{
										background: "var(--color-surface)",
										border: "1px solid var(--color-border)",
									}}
								>
									<div
										className="font-semibold text-sm mb-0.5"
										style={{ color: "var(--color-text)" }}
									>
										{c.title}
									</div>
									<div
										className="text-xs"
										style={{ color: "var(--color-muted)" }}
									>
										{c.desc}
									</div>
								</div>
							))}
						</div>
					</div>
				) : (
					<div className="max-w-3xl mx-auto">
						{messages.map((msg, i) => {
							const isLast = i === messages.length - 1;
							// canRetry only matters for the last assistant message — that's
							// where the regenerate button renders. Look back to find the
							// previous user message and check whether its file bytes are
							// still available in memory.
							let canRetry = true;
							if (isLast && msg.role === "assistant") {
								for (let j = i - 1; j >= 0; j--) {
									if (messages[j].role === "user") {
										canRetry = canRegenerateFromUserMsg(messages[j]);
										break;
									}
								}
							}
							// Inject the _onPreview callback so MessageBubble's image
							// thumbnails can open the lightbox without needing the
							// component to know about ChatInterface state.
							const msgWithPreview = msg._attachments
								? { ...msg, _onPreview: (url) => setPreviewImageUrl(url) }
								: msg;
							return (
								<MessageBubble
									key={msg.id || i}
									msg={msgWithPreview}
									onEdit={handleEdit}
									onRetry={handleRetry}
									onViewReport={(m) => {
										// Pull every cached field straight off the assistant message
										// so close-then-reopen of the report restores the same vehicle
										// photos and the same generated GLB. Falls back to the previous
										// user message's _attachments when the assistant message itself
										// does not carry _userImages.
										const label = m.report
											? `${m.report.vehicle?.year || ""} ${m.report.vehicle?.make || ""} ${m.report.vehicle?.model || ""}`.trim()
											: null;
										// Resolve userImages with cascading fallbacks:
										//   1. _userImages on the assistant message (in-session)
										//   2. _attachments on the prior user message (in-session)
										//   3. imageUrls on the prior user message (Firestore-persisted,
										//      Storage HTTPS URLs — survives refresh / chat-switch)
										let userImages = Array.isArray(m._userImages) ? m._userImages : null;
										if (!userImages || userImages.length === 0) {
											// Walk back through ALL prior user messages — text-only
											// followups (e.g. "full cash for this vehicle") have no
											// imageUrls/_attachments, but an earlier turn in the same
											// chat may have uploaded photos. Don't break after the
											// first user message; keep searching.
											const idx = messages.lastIndexOf(m);
											for (let j = idx - 1; j >= 0; j--) {
												const prevM = messages[j];
												if (prevM.role !== "user") continue;
												if (Array.isArray(prevM._attachments) && prevM._attachments.some((a) => a.dataUrl)) {
													userImages = prevM._attachments.filter((a) => a.kind === "image" && a.dataUrl);
													break;
												}
												if (Array.isArray(prevM.imageUrls) && prevM.imageUrls.length > 0) {
													userImages = prevM.imageUrls.map((u) => ({ kind: "image", name: u.name, dataUrl: u.url }));
													break;
												}
												// keep walking — the photos might live on an earlier turn
											}
										}
										// glbUrl resolution:
										//   - in-memory _glbUrl is always preferred (already proxied
										//     for dev, R2-direct in prod).
										//   - Firestore glbUrl: in dev, route Tripo URLs through
										//     /dev-glb-proxy (browser CORS bypass). In prod, refuse
										//     them — Tripo CDN serves no CORS headers, so loading
										//     directly hard-errors. lookupCachedModel inside openReport
										//     can still recover an R2 URL from models3d/{slug}.
										//   - glbUrlExpiresAt: ignore the persisted URL if past
										//     expiry (Tripo's CloudFront signatures last ~24h).
										const isTripoUrl = (u) =>
											typeof u === "string" && /tripo3d\.com\//.test(u);
										const isReplicateUrl = (u) =>
											typeof u === "string" && /replicate\.delivery\//.test(u);
										const isDevEnv = process.env.NODE_ENV !== "production";
										let resolvedGlbUrl = m._glbUrl || null;
										if (!resolvedGlbUrl && m.glbUrl) {
											const expiresAt = m.glbUrlExpiresAt;
											const expired =
												typeof expiresAt === "number" && Date.now() > expiresAt;
											// Replicate URLs without a recorded expiry come from messages
											// saved before we tracked Replicate's ~1h TTL. Treat them as
											// definitively stale so the preflight doesn't CORS-fail on them
											// in the console — fall through to lookupCachedModel instead.
											const replicateNoExpiry =
												isReplicateUrl(m.glbUrl) && typeof expiresAt !== "number";
											if (!expired && !replicateNoExpiry) {
												if (isTripoUrl(m.glbUrl)) {
													if (isDevEnv) {
														resolvedGlbUrl = `/dev-glb-proxy?url=${encodeURIComponent(m.glbUrl)}`;
													}
													// prod: leave null — fall through to lookupCachedModel
												} else {
													resolvedGlbUrl = m.glbUrl;
												}
											}
										}
										openReport(
											m.report,
											m._vehicleColor || null,
											label || m._vehicleLabel || activeReport?.vehicleLabel,
											m._img64,
											m._imgMt,
											resolvedGlbUrl,
											m._modelStatus || (resolvedGlbUrl ? "Done" : null),
											userImages || [],
											m.id || null,
											activeSessionId || null,
											m._modelProvider || m.modelProvider || null,
										);
									}}
									isLast={isLast}
									isAnalyzing={isAnalyzing}
									canRetry={canRetry}
									onFeedback={(m, value) =>
										recordFeedback(activeSessionId, m.id, value)
									}
								/>
							);
						})}
						<div ref={bottomRef} />
					</div>
				)}
			</div>

			{/* Input area */}
			<div className="px-4 pb-6 pt-2">
				<div
					className="max-w-3xl mx-auto rounded-2xl overflow-hidden"
					style={{
						border: "1px solid var(--color-border)",
						background: "var(--color-surface)",
						boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
					}}
				>
					<textarea
						ref={textareaRef}
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							const el = textareaRef.current;
							if (el) {
								el.style.height = "auto";
								el.style.height = Math.min(el.scrollHeight, 220) + "px";
							}
						}}
						onKeyDown={handleKey}
						placeholder={
							activeMode === 'sell'
								? (carfaxFile || vehicleImages.length > 0
									? "Add context (mileage, condition, modifications, target sale window…) or press Enter to analyze"
									: "Describe your vehicle: year/make/model/trim/mileage/condition, upload a CARFAX & photos…")
								: (carfaxFile || vehicleImages.length > 0
									? "Add context (asking price, APR, loan term…) or press Enter to analyze"
									: "Ask about a vehicle, upload a CARFAX & photos, or paste a screenshot…")
						}
						rows={1}
						disabled={isAnalyzing}
						className="w-full px-4 pt-4 pb-2 text-sm resize-none outline-none disabled:opacity-60"
						style={{
							background: "transparent",
							color: "var(--color-text)",
							minHeight: 52,
							maxHeight: 220,
							overflowY: "auto",
						}}
					/>
					<div className="flex items-center justify-between px-3 pb-3 gap-2">
						<UploadArea
							carfaxFile={carfaxFile}
							vehicleImages={vehicleImages}
							onCarfaxChange={setCarfaxFile}
							onVehicleImagesChange={setVehicleImages}
							onPreviewImage={(url) => setPreviewImageUrl(url)}
						/>
						<button
							onClick={handleSend}
							disabled={
								isAnalyzing ||
								(!input.trim() && !carfaxFile && vehicleImages.length === 0)
							}
							className="w-9 h-9 rounded-xl flex items-center justify-center transition-all disabled:opacity-30"
							style={{ background: "var(--color-accent)" }}
						>
							<Send size={16} className="text-white" />
						</button>
					</div>
				</div>
				<p
					className="text-center text-xs mt-2"
					style={{ color: "var(--color-muted)" }}
				>
					VinCritiq provides estimates for informational purposes only. Always
					verify with a licensed dealer.
				</p>
			</div>

					</div>{/* /chat panel */}

					{/* Find panel — listings search funnel */}
					<div className="h-full">
						<FindACarPanel
							onBack={() => setActiveMode(previousModeRef.current || 'buy')}
							onAnalyzeListing={(listing) => {
								// Funnel into Buy: switch mode, drop a pre-filled
								// "Analyze this VIN" prompt into the chat input, and
								// kick off the analysis. CARFAX auto-fetch will run
								// inside runAnalysis since it sees a VIN in the
								// extra-text argument.
								setActiveMode('buy');
								// Live listings routinely omit price, mileage, or trim —
								// dealers withhold price ("call for price") and private
								// sellers skip odometer readings. Interpolating blindly threw
								// on `null.toLocaleString()` and took the whole panel down,
								// so each field is optional and simply omitted when absent.
								const num = (n) => (Number.isFinite(n) ? n.toLocaleString() : null);
								const facts = [
									`VIN: ${listing.vin}`,
									num(listing.price) ? `asking $${num(listing.price)}` : 'asking price not listed',
									num(listing.mileage) ? `${num(listing.mileage)} miles` : 'mileage not listed',
								];
								const where = [listing.dealer?.city, listing.dealer?.state].filter(Boolean).join(', ');
								if (listing.dealer?.name) {
									facts.push(`at ${listing.dealer.name}${where ? ` in ${where}` : ''}`);
								} else if (where) {
									facts.push(`in ${where}`);
								}
								const name = [listing.year, listing.make, listing.model, listing.trim]
									.filter(Boolean)
									.join(' ');
								const prompt = `Analyze this vehicle for me: ${name || 'this listing'}, ${facts.join(', ')}.`;
								setInput(prompt);
								if (textareaRef.current) {
									// Bump the textarea height so the long prefilled
									// prompt is visible without the user needing to scroll.
									setTimeout(() => {
										const el = textareaRef.current;
										if (el) {
											el.style.height = 'auto';
											el.style.height = Math.min(el.scrollHeight, 220) + 'px';
											el.focus();
										}
									}, 360);
								}
							}}
						/>
					</div>
				</div>{/* /mode-track */}
			</div>{/* /track wrapper */}

			{showContextModal && (
				<ContextModal
					onAddContext={() => setShowContextModal(false)}
					onBeginAnalysis={() => runAnalysis("")}
					onClose={() => setShowContextModal(false)}
				/>
			)}

			{previewImageUrl && (
				<div
					onClick={() => setPreviewImageUrl(null)}
					className="fixed inset-0 z-[60] flex items-center justify-center cursor-zoom-out"
					style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(8px)" }}
					role="dialog"
					aria-label="Image preview"
				>
					<img
						src={previewImageUrl}
						alt="Attached vehicle"
						className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
						style={{ objectFit: "contain" }}
					/>
				</div>
			)}

			{showReportModal && activeReport && activeReport.mode === 'sell' && (
				<SellReportModal
					report={activeReport.report}
					vehicleLabel={activeReport.vehicleLabel}
					onClose={() => setShowReportModal(false)}
				/>
			)}

			{showReportModal && activeReport && activeReport.mode !== 'sell' && (
				<ReportModal
					report={activeReport.report}
					vehicleColor={activeReport.vehicleColor}
					vehicleLabel={activeReport.vehicleLabel}
					imageBase64={activeReport.imageBase64}
					imageMediaType={activeReport.imageMediaType}
					glbUrl={activeReport.glbUrl}
					modelStatus={activeReport.modelStatus}
					modelProvider={activeReport.modelProvider || null}
					sessionId={activeReport.sessionId || null}
					messageId={activeReport.messageId || null}
					layout={reportLayout}
					onChangeLayout={setReportLayout}
					widthPct={reportWidthPct}
					onChangeWidthPct={setReportWidthPct}
					onResizingChange={setIsResizingReport}
					userImages={activeReport.userImages || []}
					onAddImage={handleAddImageToReport}
					isReanalyzing={isAnalyzing}
					onClose={() => setShowReportModal(false)}
					onConfirmEdits={(edits) => {
						// Keep the modal open — activeReport will be swapped in place
						// when the new <REPORT> streams back (openReport re-sets it).
						const msg =
							`Re-analyze this deal with these updated financing terms and give me a fresh <REPORT> using these exact numbers:\n` +
							`- Sale Price: $${Math.round(edits.price).toLocaleString()}\n` +
							`- Down Payment: $${Math.round(edits.downPayment).toLocaleString()}\n` +
							`- APR: ${edits.apr}%\n` +
							`- Term: ${edits.termMonths} months\n` +
							`Computed on the client: monthly ≈ $${Math.round(edits.monthly).toLocaleString()}, total interest ≈ $${Math.round(edits.totalInterest).toLocaleString()}, total cost ≈ $${Math.round(edits.totalCost).toLocaleString()}.\n` +
							`Re-evaluate the deal rating (Great/Good/Fair/Bad) given these terms and the same vehicle. Keep the vehicle, depreciation, and market values the same; only the financing block and verdict should change.`;
						// Re-analyze ONLY runs Claude — same vehicle, so the 3D
						// model is preserved as-is. No regeneration, no slug
						// cache lookup, no provider call. Snapshot the existing
						// glbUrl/modelStatus from the open report and hand them
						// through to the new openReport call inside runAnalysis.
						runAnalysis(msg, {
							keepExistingModel: true,
							existingGlbUrl: activeReport?.glbUrl || null,
							existingModelStatus: activeReport?.modelStatus || null,
						});
					}}
				/>
			)}
		</div>
	);
}
