import { useHaptics } from "@/hooks/use-haptics";

export function usePlaceBid() {
	const haptics = useHaptics();

	const action = () => {
		haptics.success();
	};

	return { action, state: undefined };
}
