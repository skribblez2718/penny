<?php
// Source-level WordPress-style oracle; no WordPress bootstrap required.
function persist_record($value) { return $value; }
function persist_decoy($value) { return $value; }
function handle_record($input_value) {
    $assigned_value = $input_value;
    if ($assigned_value !== null) {
        $guarded_action = $assigned_value;
        $sink_value = $guarded_action;
        persist_record($sink_value);
    } else {
        persist_decoy('unrelated');
    }
}
function decoy_handler($decoy_value) { return $decoy_value; }
add_action('init', 'handle_record');
add_action('shutdown', 'decoy_handler');
