extends Camera2D

# 屏幕震动：trauma 衰减模型，offset 抖动

var _trauma := 0.0
var _seed_phase := 0.0


func _ready() -> void:
	_seed_phase = randf() * TAU


func add_trauma(amount: float) -> void:
	_trauma = minf(1.0, _trauma + amount)


func _process(delta: float) -> void:
	# 顿帧期间画面冻结，不做抖动
	if Engine.time_scale < 1.0:
		return
	_trauma = maxf(0.0, _trauma - delta * 3.0)
	if _trauma <= 0.001:
		offset = Vector2.ZERO
		return
	var amp := _trauma * _trauma * 12.0
	var t := Time.get_ticks_msec() * 0.001
	offset = Vector2(
		sin(t * 62.0 + _seed_phase) * amp,
		cos(t * 49.0 + _seed_phase * 1.7) * amp
	)
