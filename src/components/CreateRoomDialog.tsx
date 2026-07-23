import { useState } from "react";
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
import type { Project } from "@/types";

type Props = {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  onCreate: (body: { name: string; topic: string; projectId?: string }) => void;
};

export function CreateRoomDialog({ open, onClose, projects, onCreate }: Props) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [projectId, setProjectId] = useState<string>("none");

  function reset() {
    setName("");
    setTopic("");
    setProjectId("none");
  }

  function submit() {
    if (!name.trim()) return;
    onCreate({
      name: name.trim(),
      topic: topic.trim(),
      projectId: projectId === "none" ? undefined : projectId,
    });
    reset();
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create new room</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sprint Planning"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Topic</label>
            <Textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={2}
              placeholder="What's this room for?"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Project</label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder="Ungrouped" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Ungrouped</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}