import { useEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";
import { JoinScreen } from "./ui/JoinScreen";
import { SyncleScreen } from "./ui/SyncleScreen";
import { MapEditorScreen } from "./ui/MapEditorScreen";
import { useSyncle } from "./state/syncleStore";
import {
  startConnectionController,
  type ConnectCache,
  type ConnectionController,
} from "./data/connectionController";

type Mode = "join" | "editor";

export default function App() {
  const [room, setRoom] = useState<Room | null>(null);
  const [cache, setCache] = useState<ConnectCache | null>(null);
  const [mode, setMode] = useState<Mode>("join");
  const reset = useSyncle((s) => s.reset);
  const clearPeers = useSyncle((s) => s.clearPeers);
  const setReconnect = useSyncle((s) => s.setReconnect);

  const controllerRef = useRef<ConnectionController | null>(null);

  // Make sure any in-flight controller is disposed if the component unmounts.
  useEffect(
    () => () => {
      void controllerRef.current?.dispose();
      controllerRef.current = null;
    },
    [],
  );

  function handleConnected(initialRoom: Room, cache: ConnectCache): void {
    // Tear down any prior controller (defensive — JoinScreen normally only
    // hands us one connection per mount).
    void controllerRef.current?.dispose();
    controllerRef.current = startConnectionController({
      initialRoom,
      cache,
      onState: (state) => {
        if (state.kind === "connected") {
          // Swap in the new Room; SyncleScreen re-attaches all its effects
          // because they're keyed on `[room]`. Clear peers so we don't carry
          // ghosts from before the drop.
          clearPeers();
          setReconnect(null);
          setRoom(state.room);
        } else if (state.kind === "reconnecting") {
          setReconnect({ attempt: state.attempt, reason: state.reason });
        } else {
          // gaveUp: surface the failure and bounce back to the join screen.
          // M2 §3b: a kick's data-channel notice may land after the
          // `removeParticipant` disconnect — in that case the disconnect
          // reason is PARTICIPANT_REMOVED and we fall back to a generic
          // "removed from room" notice (empty reason) for the join screen.
          if (
            state.reason === "PARTICIPANT_REMOVED" &&
            !useSyncle.getState().kicked
          ) {
            useSyncle.getState().setKicked({ reason: "" });
          }
          setReconnect(null);
          handleLeave();
        }
      },
    });
    setReconnect(null);
    setRoom(initialRoom);
    setCache(cache);
  }

  function handleLeave(): void {
    void controllerRef.current?.dispose();
    controllerRef.current = null;
    setReconnect(null);
    setRoom(null);
    setCache(null);
    reset();
  }

  function handleRetryNow(): void {
    controllerRef.current?.retryNow();
  }

  if (room) {
    return (
      <SyncleScreen
        room={room}
        cache={cache}
        onLeave={handleLeave}
        onRetryReconnect={handleRetryNow}
      />
    );
  }
  if (mode === "editor") {
    return <MapEditorScreen onClose={() => setMode("join")} />;
  }
  return (
    <JoinScreen
      onConnected={handleConnected}
      onOpenEditor={() => setMode("editor")}
    />
  );
}
