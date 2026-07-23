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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import type { Task, Agent } from "@/types";

type Props = {
  open: boolean;
  onClose: () => void;
  task?: Task;
  agents: Agent[];
  onSave: (patch: Partial<Task>) => void;
  onDelete?: (id: string) => void;
};

export function TaskEditDialog({ open, onClose, task, agents, onSave, onDelete }: Props) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [status, setStatus] = useState<Task["status"]>(task?.status ?? "todo");
  const [assigneeId, setAssigneeId] = useState<string>(task?.assigneeId ?? "none");

  useEffect(() => {
    setTitle(task?.title ?? "");
    setStatus(task?.status ?? "todo");
    setAssigneeId(task?.assigneeId ?? "none");
  }, [task?.id]);

  function save() {
    onSave({
      title,
      status,
      assigneeId: assigneeId === "none" ? undefined : assigneeId,
    });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{task ? "Edit task" : "New task"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-sm font-medium">Status</label>
              <Select value={status} onValueChange={(v) => setStatus(v as Task["status"])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todo">todo</SelectItem>
                  <SelectItem value="doing">doing</SelectItem>
                  <SelectItem value="blocked">blocked</SelectItem>
                  <SelectItem value="done">done</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Assignee</label>
              <Select value={assigneeId} onValueChange={setAssigneeId}>
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          {task && onDelete && (
            <Button
              variant="destructive"
              onClick={() => {
                onDelete(task.id);
                onClose();
              }}
            >
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!title.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}