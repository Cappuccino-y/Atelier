extends Node

# 打击感 3 件套：顿帧 + 屏幕震动 + 闪白
# 顿帧用 Engine.time_scale 降到 0.05，持续固定物理帧数后恢复

const HITSTOP_SCALE := 0.05

var camera: Camera2D

var _hitstop_frames := 0


func _ready() -> void:
	# 顿帧计数在暂停状态下也要走完，避免升级暂停时 time_scale 卡在低速
	process_mode = Node.PROCESS_MODE_WHEN_PAUSED


func _physics_process(_delta: float) -> void:
	if _hitstop_frames > 0:
		_hitstop_frames -= 1
		if _hitstop_frames == 0:
			Engine.time_scale = 1.0


func hit_stop(frames: int = 2) -> void:
	_hitstop_frames = maxi(_hitstop_frames, frames)
	Engine.time_scale = HITSTOP_SCALE


func shake(amount: float) -> void:
	if camera != null and camera.has_method("add_trauma"):
		camera.add_trauma(amount)


func flash_white(target: CanvasItem, duration: float = 0.12) -> void:
	if target == null:
		return
	var original := target.modulate
	# 超亮 modulate 把像素炸白，再渐回原色
	target.modulate = Color(3.0, 3.0, 3.0, 1.0)
	var tw := target.create_tween()
	tw.tween_property(target, "modulate", original, duration)
