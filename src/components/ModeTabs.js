import { Search, ShoppingCart, Tag } from "lucide-react";
import React from "react";
import { useChat } from "../contexts/ChatContext";

// Top-of-chat segmented control that switches the analysis mode:
//
//   Buy a Car   — current default; evaluates a listing as a buy decision
//   Sell a Car  — analyzes the user's vehicle and recommends best sale channel
//   Find Me a Car — placeholder for future personalized recommendation flow
//
// Switching tabs doesn't load a session; it just changes the active mode.
// The sidebar then filters its session list to sessions tagged with the new
// mode, and any new chat the user starts gets tagged with the new mode.
//
// Labels chosen for clarity over cleverness — the user's brief said titles
// can be tweaked for UX, and "Buy a Car / Sell a Car / Find Me a Car" reads
// the same way a friend would offer to help.
// Each tab carries a short label as well as the full one. On a 430px phone the
// header also has to hold a menu button and the session-info control, and
// "Buy a Car / Sell a Car / Find Me a Car" overflows well before that fits —
// the third tab was being clipped mid-word. Below sm we show the short form.
const TABS = [
	{
		id: "buy",
		label: "Buy a Car",
		short: "Buy",
		icon: ShoppingCart,
		description: "Analyze a listing — is it a good deal?",
	},
	{
		id: "sell",
		label: "Sell a Car",
		short: "Sell",
		icon: Tag,
		description: "Find the best price to sell your vehicle",
	},
	{
		id: "find",
		label: "Find Me a Car",
		short: "Find",
		icon: Search,
		description: "Search live dealer inventory",
		disabled: false,
	},
];

export default function ModeTabs() {
	const { activeMode, setActiveMode, startNewChat } = useChat();

	const handleClick = (mode) => {
		if (mode === activeMode) return;
		setActiveMode(mode);
		// Switching modes lands the user on an empty new-chat state for that
		// tab. The sidebar still shows sessions of the new mode so they can
		// click into one if they want; otherwise they start fresh.
		if (typeof startNewChat === "function") startNewChat();
	};

	return (
		<div
			className="flex items-center gap-1 p-1 rounded-xl mx-auto"
			style={{
				background: "var(--color-surface)",
				border: "1px solid var(--color-border)",
				maxWidth: 480,
			}}
			role="tablist"
			aria-label="Analysis mode"
		>
			{TABS.map((tab) => {
				const Icon = tab.icon;
				const active = activeMode === tab.id;
				return (
					<button
						key={tab.id}
						onClick={() => !tab.disabled && handleClick(tab.id)}
						disabled={tab.disabled}
						role="tab"
						aria-selected={active}
						title={tab.description}
						className="flex-1 flex items-center justify-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all disabled:cursor-not-allowed"
						style={{
							background: active ? "var(--color-accent)" : "transparent",
							color: active
								? "#fff"
								: tab.disabled
									? "var(--color-muted)"
									: "var(--color-text)",
							opacity: tab.disabled ? 0.5 : 1,
							fontWeight: active ? 600 : 500,
						}}
					>
						<Icon size={14} className="flex-shrink-0" />
						<span className="whitespace-nowrap hidden sm:inline">{tab.label}</span>
						<span className="whitespace-nowrap sm:hidden">{tab.short}</span>
					</button>
				);
			})}
		</div>
	);
}
