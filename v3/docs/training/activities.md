# Activity vocabulary

Official list checked **2026-10-15**, from [NIST ActEV'21 SDL](https://actev.nist.gov/sdl). These are class identifiers, not this project's supported detection features. Availability and annotation aliases still need checking in the chosen MEVA release.

```text
person_abandons_package
person_closes_facility_door
person_closes_trunk
person_closes_vehicle_door
person_embraces_person
person_enters_scene_through_structure
person_enters_vehicle
person_exits_scene_through_structure
person_exits_vehicle
hand_interacts_with_person
person_carries_heavy_object
person_interacts_with_laptop
person_loads_vehicle
person_transfers_object
person_opens_facility_door
person_opens_trunk
person_opens_vehicle_door
person_talks_to_person
person_picks_up_object
person_purchases
person_reads_document
person_rides_bicycle
person_puts_down_object
person_sits_down
person_stands_up
person_talks_on_phone
person_texts_on_phone
person_steals_object
person_unloads_vehicle
vehicle_drops_off_person
vehicle_picks_up_person
vehicle_reverses
vehicle_starts
vehicle_stops
vehicle_turns_left
vehicle_turns_right
vehicle_makes_u_turn
```

The notebook selects visible descriptions useful to the parking/entrance experiment: opening/closing a vehicle door or trunk, entering/exiting/loading/unloading a vehicle, picking up/putting down/transferring/carrying an object, riding a bicycle and vehicle start/stop. `unknown` is a JagaAI abstention/verified-negative class, not a MEVA class. This subset intentionally excludes `person_steals_object`; source annotations do not authorize JagaAI to infer ownership, identity, intent, or criminal responsibility.

R1 loitering and R3 restricted-area entry are not identical to any of these labels. VLM activity precision/recall cannot substitute for end-to-end rule evaluation. Single-frame VLM labels also cannot validate the duration or continuity of an action; the notebook uses ordered frames and still requires original-video verification.
