import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { X } from "lucide-react";
import type { Room, Agent } from "@/types";

type Props = {
  open: boolean;
  onClose: () => void;
  room: Room;
  agents: Agent[];
  onSave: (patch: Partial<Room>) => void;
};

export function RoomSettingsDialog({ open, onClose, room, agents, onSave }: Props) {
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic ?? "");
  const [status, setStatus] = useState<Room["status"]>(room.status);
  const [agentIds, setAgentIds] = useState<string[]>(room.agentIds);

  useEffect(() => {
    setName(room.name);
    setTopic(room.topic ?? "");
    setStatus(room.status);
    setAgentIds(room.agentIds);
  }, [room.id, room.name, room.topic, room.status, room.agentIds]);

  function toggleAgent(id: string) {
    setAgentIds((curr) =>
      curr.includes(id) ? curr.filter((x) => x !== id) : [...curr, id],
    );
  }

  function save() {
    onSave({ name, topic, status, agentIds });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Room settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium">Topic</label>
            <Textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={2}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Status</label>
            <Select value={status} onValueChange={(v) => setStatus(v as Room["status"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
                <SelectItem value="self-talk">Self-Talk</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium">Agents</label>
            <div className="flex flex-wrap gap-1 mt-1">
              {agents
                .filter((a) => a.id !== "user")
                .map((a) => {
                  const active = agentIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleAgent(a.id)}
                      className={`tag-badge ${
                        active ? "bg-primary text-primary-foreground" : "bg-muted"
                      }`}
                    >
                      {a.name}
                      {active && <X className="h-3 w-3 ml-1" />}
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}