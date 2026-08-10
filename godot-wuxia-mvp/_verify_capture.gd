extends SceneTree

var _t := 0.0
var _started := false

func _initialize() -> void:
	var err := change_scene_to_file("res://scenes/main.tscn")
	print("change_scene err=", err)
	_started = true

func _process(delta: float) -> bool:
	if not _started:
		return false
	_t += delta
	if _t > 2.5:
		var img := root.get_texture().get_image()
		var err := img.save_png("res://_verify_capture.png")
		print("saved err=", err)
		return true
	return false
