const CHECKPOINTS = Object.freeze([
  {
    stage_round: "2-2",
    checkpoint_id: "direction_exploration",
    strategy_block_id: "lineup_direction_commitment",
    block_sequence: 1,
    block_role: "explore",
    supersedes_prior_same_block: false,
    semantic_label: "fixed_checkpoint_2_2_direction_exploration",
    priority_band: "P2",
    scorer_checkpoint: "explore_candidates",
    focus: "explore_and_prepare",
    answer_contract: {
      action_brief: `本轮目标是完成 2-2 方向探索，而不是提前锁死一套阵容。优先从当前 Match 固定的 Master+ Ranking 取得 5 套完整、原子且真实的候选；只有首批结果明确存在覆盖缺口时才扩展到 10 套工作集。结合用户已确认的 2-1 强化、强化等级、固定或待解析奖励、神器、转职、铲子/锅、已记录装备以及当前可用的直接 Ranking/typed relation 证据比较候选。早期血量、金币和当前阶段主要影响过渡与执行节奏，不应机械取代最终阵容强度和成型适配。

玩家可见回答在当前证据支持至少三套时，应给出至少 3 套彼此不同、真实可执行的方向；同一家族默认最多展示两条方向，其他独立原子阵容作为有自己强度和条件的分支说明，不合并统计，也不因相似就隐去可查询身份。不要因为当前棋盘偏向某一条路线就只输出一套或两套。每套候选尽量包含名称、完整成员、目标人口、主 C、主坦、核心装备与替代项、主要过渡、启动或搜牌窗口、成型负担、主线/备选及切换条件，并说明 2-4 选秀优先级和 3-2 强化可能改变什么。内部字段名不要作为标题输出。

如果已知神器或转职，优先加入或抬高有当前 Ranking 强度证据的适配阵容，并说明推荐持有者、关键羁绊和条件。如果用户已确认的强化本身会立即、延迟或按条件发放随机/可选神器或转职，且该强化的 reward promise 尚未解析出实际奖励，并且结果会显著改变候选，只问一个聚焦问题让用户确认实际拿到的奖励；不要把未解析的强化奖励当成已拥有事实，也不要为每种可能奖励展开假设阵容。`,
      primary_decision: "lineup_direction_exploration",
      candidate_policy: "at_least_three_visible_candidates_when_supported",
      required_decisions: [
        "complete_candidate_rosters",
        "standard_master_plus_candidate_identity",
        "mature_recipe_variant_differences_without_creating_an_automatic_backup_branch",
        "candidate_carry_tank_and_core_traits",
        "candidate_archetype_and_lifecycle",
        "population_5_6_7_transition_path",
        "target_population_and_star_targets",
        "formation_cost_and_burden",
        "current_equipment_fit",
        "current_augment_fit",
        "carousel_2_4_unit_and_item_priorities",
        "mainline_backup_and_switch_condition",
        "what_the_3_2_choice_can_change",
      ],
      supporting_decisions: ["economy_posture", "streak_posture", "board_as_low_weight_transition_evidence"],
    },
  },
  {
    stage_round: "2-7",
    checkpoint_id: "pre_3_2_direction_preparation",
    strategy_block_id: "lineup_direction_commitment",
    block_sequence: 2,
    block_role: "prepare_next_choice",
    supersedes_prior_same_block: false,
    semantic_label: "fixed_checkpoint_2_7_pre_3_2_preparation",
    priority_band: "P2",
    scorer_checkpoint: "prepare_next_choice",
    focus: "prepare_next_choice",
    answer_contract: {
      action_brief: `本轮目标是为 3-2 强化选择和下一搜牌窗口做准备，不重新执行完整 2-2 探索。保留仍成立的领先方向和备选，并说明当前缺口与会改变排序的条件。未确认最终阵容时，分别给候选适合的 3-2 强化类型和代表性例子；已有 durable target 时，只给该目标的强化方向和例子。结合 Runtime 提供的下一强化等级概率，但不得把概率当成实际候选。

如果候选或目标含二费核心追三星，只预告六级慢 D 的正常窗口、何时需要先提两星质量、投入和停止条件，不另行生成六人口过渡阵容。

如果仍保留的候选或 durable target 属于三费核心追三星、四费运营或五费/九五方向，给出该方向当前可执行的完整六人口过渡阵容。已有 durable target 时只给目标方向；尚未确认目标时，为仍真实保留的领先方向和备选分别给一套。优先恢复同一原子候选的 current Ranking transition chain 或明确关联的胜率/热门人口变体；列出六人口全部成员、临时主 C/主坦或装备持有者、过渡棋子、装备延续、升七后的替换顺序和下一阶段要保留的核心牌。没有直接发布过渡时，只能在同一候选内做有根据的一换一临时调整并标记证据较弱，不得跨候选拼接。

提醒用户把已合装备、散件、神器和转职记录到对应卡片，因为这些事实会影响 3-2 强化和后续巡航；不要为了收集不会改变决策的信息追加问题。`,
      primary_decision: "prepare_3_2_choice_and_direction",
      candidate_policy: "keep_current_directions_open_until_choice_evidence",
      required_decisions: [
        "current_direction_leader_and_backup",
        "missing_equipment_only_if_material",
        "reroll_timing_if_candidate_requires_it",
        "what_3_2_choice_changes",
        "pre_choice_switch_condition",
      ],
      supporting_decisions: ["economy_and_level_posture", "streak_protection"],
    },
  },
  {
    stage_round: "3-3",
    checkpoint_id: "post_3_2_narrowing",
    strategy_block_id: "lineup_direction_commitment",
    block_sequence: 3,
    block_role: "narrow",
    supersedes_prior_same_block: true,
    semantic_label: "fixed_checkpoint_3_3_post_augment_narrowing",
    priority_band: "P1",
    scorer_checkpoint: "narrow_candidates",
    focus: "narrow_after_choice",
    answer_contract: {
      action_brief: `本轮目标是结合截至当前已确认的全部强化、装备和散件、已拥有的关键棋子、经济血量及最新局面收束方向。没有 durable target 时，把真实候选收束到最多 3 套，给出主线、备选、退出条件、下一人口和搜牌窗口。普通强化、新装备或已拥有核心牌使当前候选排序发生实质变化时，也可以从当前完整 Master+ 池精确补查一条新方向，替换较弱候选；商店里未买下的棋子只是行动机会。3-2 强化产生神器、转职、金铲铲或金锅锅时，先读取 reward promise：实际神器/转职已解析时，查询并增补或抬高最多一套有当前 Ranking 强度证据的适配方向；只确定获得铲子或锅时，不追问不存在的结果，而是结合现有候选、Core 合成配方和 Ranking 关系推荐优先可合转职。新增方向与现有候选相同时合并证据；确实是新方向且会改变决策时替换较弱普通候选，不机械扩大报告。

如果强化承诺随机/可选神器或转职但实际奖励尚未解析，并且不同结果会显著改变候选或持有者，只问一个聚焦问题；其他能够成立的策略内容先正常交付。用户回答后，把实际奖励和最多一套新增候选写回持久候选工作集。

已有 durable target 时不重新选阵。神器优先判断目标内主 C、主坦或其他单位谁真正适配；转职优先判断目标内羁绊变体、携带者、人口调整和强度变化。只有当前 Ranking 存在明显更强、装备接近且当前阶段仍可执行的转职方向时，才额外说明转型及代价，不能静默替换用户目标。

如果候选或目标属于二费核心追三星，结合张数、关键单位两星质量、盘面、六级后的经济和生存压力，判断卡六慢 D、短暂加大投入、恢复经济和停止追三条件。给出 3-4 选秀优先级。`,
      primary_decision: "narrow_after_3_2_choice",
      candidate_policy: "up_to_three_real_directions",
      required_decisions: [
        "choice_effect_on_each_direction",
        "complete_candidate_rosters_and_roles",
        "preserve_each_complete_candidate_identity_without_cross_lineup_mixing",
        "mainline_backup_and_pivot_condition",
        "next_population_and_roll_window",
        "carousel_3_4_unit_item_and_emblem_priorities",
      ],
      supporting_decisions: ["economy_posture", "current_board_quality"],
    },
  },
  {
    stage_round: "3-5",
    checkpoint_id: "three_cost_reroll_or_operation",
    strategy_block_id: "formation_readiness_and_execution",
    block_sequence: 1,
    block_role: "operate_or_reroll",
    supersedes_prior_same_block: false,
    semantic_label: "fixed_checkpoint_3_5_reroll_or_operation",
    priority_band: "P1",
    scorer_checkpoint: "provisional_commit",
    focus: "reroll_or_operation",
    answer_contract: {
      action_brief: `本轮先按当前候选或 durable target 的生命周期分流，不把三费追三、四费运营和九五套用成同一种七级建议。

方向明确包含三费核心追三星时，结合主 C 张数、其他必要三费两星/三星数量、同行、血量、盘面强度、当前经济，以及拉七后仍可用于 D 牌和买牌的资金，判断 3-5 拉七启动还是等到 3-7。说明拉七后需要保留的行动空间、优先搜到的最低两星质量、停手恢复经济和张数不足时退出的条件。多个必要三费三星通常留七完成核心集合；只有一个主要三费追三时，如果基础战力稳定且八级能显著补关键高费单位、关键羁绊或人口空间，才讨论上八继续追。普通四费在七级也可能出现，不得说成只有八级才会出现。

如果候选或 durable target 是四费运营或九五，选择绑定该方向的七人口 transition/variant 身份供 Runtime 物化完整过渡阵容。最终回答应包含七人口全部成员、临时主 C/主坦或装备持有者、核心装备延续、升八替换顺序和下一张关键单位；随后判断是否需要少量搜到稳血的两星质量，以及为 4-1/4-2 启动保留的经济。没有直接发布过渡时，只在同一候选内做明确的一换一临时调整并标记不确定性，不得跨候选拼接。`,
      primary_decision: "applicable_three_cost_carry_three_star_reroll_or_operation",
      candidate_policy: "discuss_three_cost_reroll_only_when_the_confirmed_or_selected_target_is_a_three_cost_carry_three_star_line; include_level_7_transition_only_for_four_cost_or_nine_five_candidates",
      required_decisions: [
        "three_cost_carry_three_star_target_check",
        "copy_progress_and_contest_pressure",
        "level_7_transition_for_four_cost_or_nine_five_candidates",
        "roll_now_or_wait_until_3_7",
        "exit_condition_if_progress_is_insufficient",
      ],
      execution_scope: "At 3-5, provide the complete bound level-7 transition roster when a supplied candidate or durable target is four-cost operation or nine-five; reserve the 4-1 versus 4-2 level-8 startup comparison for 3-7.",
      supporting_decisions: ["equipment_continuity", "current_floor_quality"],
    },
  },
  {
    stage_round: "3-7",
    checkpoint_id: "pre_4_stage_fork",
    strategy_block_id: "formation_readiness_and_execution",
    block_sequence: 2,
    block_role: "prepare_stage_four_fork",
    supersedes_prior_same_block: true,
    semantic_label: "fixed_checkpoint_3_7_pre_4_stage_fork",
    priority_band: "P1",
    scorer_checkpoint: "provisional_commit",
    focus: "phase_fork",
    answer_contract: {
      action_brief: `本轮目标是在四阶段前完成真实方向分叉、装备复查和 4-2 预告。没有 durable target 时最多保留两条明确命名的真实方向；已有 durable target 时，所有判断只服务该目标。

按生命周期分别判断：一费追三检查核心是否已三星或接近完成，严重不足时判断继续争三星、升级补羁绊还是止损争名次；二费追三结合张数、盘面和经济判断慢 D、加大投入或恢复经济；三费追三结合 3-5 是否启动、关键两星、张数、同行、血量和经济判断七级继续投入、等待或准备上八；四费运营重点说明 4-1/4-2 拉八后的搜牌底线和最终盘面；九五或十人口方向同时判断当前盘面能否继续扛、是否需用四费质量稳血、上九后的 D 牌和买牌资金及剩余容错。

复查已合装备、当前持有者、后续转移顺序、过渡棋子替换和剩余成型缺口。为最多两条候选分别给出 4-2 强化方向与例子；已有 durable target 时只给该目标。可以使用银/金/彩概率背景，但不能提前假定具体强化会出现。`,
      primary_decision: "pre_4_stage_direction_fork",
      candidate_policy: "at_most_two_real_directions_or_explicitly_keep_open",
      required_decisions: [
        "current_mainline_and_backup",
        "level_8_at_4_1_vs_4_2_cost_and_contest_tradeoff",
        "four_cost_operation_vs_nine_five_route",
        "equipment_and_transition_continuity",
        "current_item_holders_and_transfer_order",
        "target_progress_and_transition_replacement_order",
        "material_equipment_gap_or_pivot_condition",
        "what_4_2_choice_can_change",
      ],
      equipment_policy: "review_existing_completed_items_and_transition_holders_before_stage_four; do not open a separate equipment checkpoint",
      supporting_decisions: ["economy_posture", "blood_and_board_tolerance"],
    },
  },
  {
    stage_round: "4-3",
    checkpoint_id: "final_lineup_confirmation",
    strategy_block_id: "lineup_direction_commitment",
    block_sequence: 4,
    block_role: "commit",
    supersedes_prior_same_block: true,
    semantic_label: "fixed_checkpoint_4_3_final_lineup_confirmation",
    priority_band: "P1",
    scorer_checkpoint: "commit_and_execute",
    focus: "final_confirmation",
    answer_contract: {
      action_brief: `本轮目标是确认最终阵容身份并让 Runtime 物化卡片。没有 durable target 时，基于当前候选、用户最新自然语言和必要的 Ranking/热门阵容查询，推动用户确认一个完整目标；仍有真实分叉时最多保留两个分别命名的最后选择，不能拼成一套。用户可以确认候选名单之外的阵容；除非启用了别吃大数据，应精确查询并解析该方向。

4-2 强化产生神器、转职、金铲铲或金锅锅时，执行统一 reward promise 解析。已知神器/转职增补或抬高最多一套有当前 Ranking 强度证据且四阶段仍可执行的方向；只知道铲子或锅时，根据候选、配方、装备接近度和局面推荐可合转职，不要求用户报告尚不存在的具体转职。随机/可选结果尚未解析且会改变最终选择时只问一次。新增方向相同则合并，确实是新方向时进入最终比较并替换较弱方向，不无限增加选项。

已有 durable target 时，检查启动结果、缺口、最后必要的一换一调整和真正转型条件。神器优先分配给目标内适配单位；转职优先服务目标内变体。只有有当前 Ranking 证据、明显更强、装备接近且仍可执行时，才说明候选外转型及代价。提交最小 candidate/variant 或 user-custom 身份与语义调整；Runtime 负责完整卡片。给 4-4 选秀优先级，卡片缺非关键事实时仍交付正文。`,
      primary_decision: "final_lineup_confirmation",
      candidate_policy: "one_confirmed_target_or_two_last_valid_choices",
      required_decisions: [
        "complete_final_roster",
        "lock_one_complete_target_candidate_identity_or_two_separately_named_last_choices",
        "forbid_silent_member_equipment_or_cap_mixing_across_standard_popular_winning_and_user_variants",
        "target_stars_and_total_piece_cost",
        "main_carry_main_tank_and_core_traits",
        "formation_and_equipment_assignments",
        "final_transition_and_pivot_condition",
        "carousel_4_4_priorities",
        "temporary_five_cost_holder_for_nine_five_when_relevant",
      ],
      supporting_decisions: ["level_8_quality", "economy_required_to_execute"],
    },
  },
  {
    stage_round: "4-5",
    checkpoint_id: "formation_readiness_review",
    strategy_block_id: "formation_readiness_and_execution",
    block_sequence: 3,
    block_role: "formation_readiness",
    supersedes_prior_same_block: true,
    semantic_label: "fixed_checkpoint_4_5_formation_readiness",
    priority_band: "P1",
    scorer_checkpoint: "formation_readiness",
    focus: "formation_readiness",
    answer_contract: {
      action_brief: `本轮以 durable target 为基准检查实际成型进度：核心牌和星级、前后排质量、关键羁绊、装备持有者、追三进度、人口空间和过渡棋子。根据目标类型判断继续搜牌、恢复经济、升级补羁绊或存钱，不默认讨论升九。

只有升级类或大经济强化、健康血量、顺利嫖卡、八级未大量花钱、当前盘面有合理容错，并且上九后仍有足够资金 D 牌和购买高费单位时，才讨论 4-5 提前上九；极限一波容错打法必须明确风险和剩余资金。给出接下来两个价值最高的动作，以及达到什么质量停手、何时放弃贪人口或追三。`,
      primary_decision: "formation_readiness_and_directionality",
      candidate_policy: "review_confirmed_target_readiness_and_only_material_execution_branches",
      required_decisions: [
        "confirmed_target_progress_and_missing_slots",
        "three_star_or_two_star_four_cost_readiness_when_relevant",
        "level_8_quality_vs_level_9_decision",
        "target_units_vs_transition_units",
        "next_two_execution_actions",
        "target_exit_condition_if_progress_is_insufficient",
      ],
      supporting_decisions: ["economy_and_hp_tolerance", "equipment_holder_continuity", "carousel_4_4_implications"],
    },
  },
  {
    stage_round: "5-1",
    checkpoint_id: "first_ceiling_floor_review",
    strategy_block_id: "cap_floor_endgame",
    block_sequence: 1,
    block_role: "first_cap_floor_review",
    supersedes_prior_same_block: false,
    semantic_label: "fixed_checkpoint_5_1_ceiling_floor",
    priority_band: "P1",
    scorer_checkpoint: "cap_floor_review",
    focus: "cap_floor",
    answer_contract: {
      action_brief: `本轮比较当前盘面下限与用户目标的真实上限，并决定本阶段投入。不要固定成四费盘面对九五：一费、二费、三费路线检查必要三星、等级、关键羁绊和继续追三价值；运营阵容检查主 C、主坦、功能位、装备与高费替换。结合血量、经济、当前质量和剩余容错，判断继续 D、升级补人口、存钱、止损保分还是争取更高上限，并给出停止投入的条件。`,
      primary_decision: "first_ceiling_floor_review",
      candidate_policy: "compare_current_floor_against_target_cap",
      required_decisions: [
        "current_floor_quality",
        "target_cap_gap",
        "roll_vs_level_vs_save_decision",
        "four_cost_board_vs_nine_five_cap",
        "replace_transition_units_and_next_population",
      ],
      supporting_decisions: ["economy_and_hp_tolerance", "equipment_distribution"],
    },
  },
  {
    stage_round: "5-3",
    checkpoint_id: "second_ceiling_floor_review",
    strategy_block_id: "cap_floor_endgame",
    block_sequence: 2,
    block_role: "cap_floor_review",
    supersedes_prior_same_block: true,
    semantic_label: "fixed_checkpoint_5_3_ceiling_floor",
    priority_band: "P1",
    scorer_checkpoint: "cap_floor_review",
    focus: "cap_floor",
    answer_contract: {
      action_brief: `使用 5-1 执行后的最新结果重新判断目标下限、上限和投入，不机械重复上一轮。说明质量投入是否有效、继续 D/升级/存钱的经济底线、下一批最有价值的任意费用替换，并加入 5-4 选秀的装备、单位、神器或转职优先级。所有判断继续服务 durable target。`,
      primary_decision: "second_ceiling_floor_review",
      candidate_policy: "compare_quality_spend_against_next_cap",
      required_decisions: [
        "current_floor_quality",
        "remaining_cap_gap",
        "5_4_carousel_item_unit_and_emblem_priorities",
        "roll_or_level_action_with_economy_limit",
        "next_cap_replacement_order",
      ],
      supporting_decisions: ["equipment_distribution", "target_validity"],
    },
  },
  {
    stage_round: "5-7",
    checkpoint_id: "late_ceiling_refresh",
    strategy_block_id: "cap_floor_endgame",
    block_sequence: 3,
    block_role: "late_cap_review",
    supersedes_prior_same_block: true,
    semantic_label: "fixed_checkpoint_5_7_late_ceiling",
    priority_band: "P1",
    scorer_checkpoint: "late_cap_refresh",
    focus: "cap_floor",
    answer_contract: {
      action_brief: `围绕生存下限和目标剩余上限，给出下一场战斗前必须完成的一个或两个动作，可以是升级、搜牌、补三星、装备转移、站位、补羁绊或任意费用的高价值替换；不要默认写成五费替换。`,
      primary_decision: "late_ceiling_floor_review",
      candidate_policy: "current_target_cap_or_survival_floor",
      required_decisions: [
        "current_floor_and_survival_margin",
        "remaining_high_value_replacements",
        "whether_to_level_or_roll_now",
        "equipment_and_five_cost_priority",
        "cap_action_before_next_combat",
      ],
      supporting_decisions: ["economy_limit", "positioning"],
    },
  },
  {
    stage_round: "6-1",
    checkpoint_id: "final_cap_positioning",
    strategy_block_id: "cap_floor_endgame",
    block_sequence: 4,
    block_role: "final_cap_review",
    supersedes_prior_same_block: true,
    semantic_label: "fixed_checkpoint_6_1_final_cap",
    priority_band: "P1",
    scorer_checkpoint: "cap_floor_review",
    focus: "cap_floor",
    answer_contract: {
      action_brief: `根据 durable target、当前成型度、血量、经济、对手信息可信度和剩余提升空间，追求现在能够实现的最强战力。判断应继续补质量、升级、完成三星、调整装备持有者、站位或替换功能单位，不默认升十，也不因阶段晚就忽略低费追三阵容的真实目标。`,
      primary_decision: "final_cap_positioning",
      candidate_policy: "optimize_the_confirmed_target_or_survival_floor",
      required_decisions: [
        "current_floor_quality",
        "final_cap_gap",
        "positioning_and_item_holder_adjustments",
        "level_10_or_quality_spend_decision",
        "next_high_value_replacement",
      ],
      supporting_decisions: ["remaining_economy", "opponent_pressure_if_observed"],
    },
  },
  {
    stage_round: "6-3",
    checkpoint_id: "final_cap_positioning_followup",
    strategy_block_id: "cap_floor_endgame",
    block_sequence: 5,
    block_role: "last_cap_review",
    supersedes_prior_same_block: true,
    semantic_label: "fixed_checkpoint_6_3_final_cap",
    priority_band: "P1",
    scorer_checkpoint: "cap_floor_review",
    focus: "cap_floor",
    answer_contract: {
      action_brief: `在 6-1 的最新执行结果上做最后阶段复查，加入 6-4 选秀优先级、最终站位、装备持有者和结束前最后一个最高价值动作。没有可靠对手站位或阵容信息时，不伪造针对性结论。`,
      primary_decision: "final_cap_positioning_followup",
      candidate_policy: "optimize_the_confirmed_target_or_survival_floor",
      required_decisions: [
        "current_floor_quality",
        "final_cap_gap",
        "6_4_carousel_item_unit_and_emblem_priorities",
        "positioning_and_item_holder_adjustments",
        "last_high_value_action_before_endgame",
      ],
      supporting_decisions: ["remaining_economy", "opponent_pressure_if_observed"],
    },
  },
]);

const RECOVERY_STAGES = Object.freeze([
  {
    stage_round: "2-5",
    recovery_id: "recover_direction_exploration",
    strategy_block_id: "lineup_direction_commitment",
    recovers_checkpoint_ids: Object.freeze(["direction_exploration"]),
    completion_policy: "pending_or_partial_only",
    host_task_policy: "recover_existing_or_add_conditional_window",
    conditional_windows: Object.freeze(["one_cost_reroll_window"]),
    completed_source_policy: "silent_unless_a_registered_conditional_window_applies",
  },
]);

const CONDITIONAL_CHECKPOINTS = Object.freeze([
  {
    stage_round: "2-5",
    checkpoint_id: "one_cost_reroll_window",
    conditional: true,
    activation_condition: "durable_target_or_retained_candidate_is_one_cost_reroll",
    strategy_block_id: "lineup_direction_commitment",
    block_sequence: 1.5,
    agenda_order: 1.5,
    block_role: "conditional_execution_window",
    supersedes_prior_same_block: true,
    semantic_label: "conditional_checkpoint_2_5_one_cost_reroll_window",
    priority_band: "P1",
    scorer_checkpoint: "one_cost_reroll_window",
    focus: "one_cost_reroll_execution",
    answer_contract: {
      action_brief: `2-5 不是普通固定巡航。先处理 2-2 方向探索义务：仍健康运行时继续同一个 owner；尚未启动且仍有时效时启动同一义务；不得创建第二次探索或第二次 Ranking 查询。若已跨过 3-2 决策窗口，不补发旧 2-2 文本，由 3-3 使用最新强化和局面吸收仍有价值的候选证据。

只有 durable target 或 2-2 当前候选中存在一费核心追三星，并且此前尚未交付对应提醒时，才额外给一次简短行动提示：说明 2-7 四级搜牌窗口、卡利息慢 D 或需要深搜的判断条件，以及张数不足时的止损方向。没有一费追三路线时保持静默。`,
      primary_decision: "one_cost_reroll_window",
      candidate_policy: "execute_the_confirmed_or_retained_one_cost_direction_only",
      required_decisions: [
        "one_cost_reroll_window",
        "current_copy_progress_if_observed",
        "level_four_roll_timing",
        "fifty_gold_slow_roll_and_recovery_posture",
        "conditions_to_roll_deeper_wait_or_level",
      ],
      supporting_decisions: ["hp_and_board_tolerance", "contest_evidence_if_observed"],
      conditional_instruction: "Only when the durable target or a retained 2-2 candidate is a one-cost reroll line, explain the level-four window around 2-7, whether to slow-roll at 50 or spend deeper, and what observed copies, HP, board strength, or contest evidence changes that timing. Do not create this obligation for unrelated directions.",
    },
  },
]);

const CHECKPOINT_BY_STAGE = new Map(CHECKPOINTS.map((entry) => [entry.stage_round, entry]));
const CHECKPOINT_BY_ID = new Map([...CHECKPOINTS, ...CONDITIONAL_CHECKPOINTS].map((entry) => [entry.checkpoint_id, entry]));
const RECOVERY_BY_STAGE = new Map(RECOVERY_STAGES.map((entry) => [entry.stage_round, entry]));

function stageOrder(stageRound) {
  const match = String(stageRound || "").trim().match(/^(\d+)-(\d+)$/);
  return match ? Number(match[1]) * 100 + Number(match[2]) : -1;
}

export function cruiseCheckpointForStage(stageRound) {
  return CHECKPOINT_BY_STAGE.get(String(stageRound || "").trim()) || null;
}

export function cruiseCheckpointById(checkpointId) {
  return CHECKPOINT_BY_ID.get(String(checkpointId || "").trim()) || null;
}

export function cruiseRecoveryPolicyForStage(stageRound) {
  const recovery = RECOVERY_BY_STAGE.get(String(stageRound || "").trim());
  if (!recovery) return null;
  return {
    ...recovery,
    recovers_checkpoint_ids: [...recovery.recovers_checkpoint_ids],
  };
}

export function cruiseRecoveryPolicyMatchesObligation(recoveryPolicy, obligationEnvelope) {
  if (!recoveryPolicy || !obligationEnvelope) return false;
  const recoverableCheckpointIds = new Set(
    Array.isArray(recoveryPolicy.recovers_checkpoint_ids)
      ? recoveryPolicy.recovers_checkpoint_ids.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
  );
  if (!recoverableCheckpointIds.size) return false;
  return (Array.isArray(obligationEnvelope.required_checkpoint_ids)
    ? obligationEnvelope.required_checkpoint_ids
    : [])
    .some((checkpointId) => recoverableCheckpointIds.has(String(checkpointId || "").trim()));
}

export function cruiseStrategyBlockForCheckpoint(checkpointOrId) {
  const checkpoint = typeof checkpointOrId === "string"
    ? cruiseCheckpointById(checkpointOrId)
    : checkpointOrId;
  return checkpoint?.strategy_block_id || null;
}

export function cruiseCheckpointBlockSnapshot(blockId) {
  const normalizedBlockId = String(blockId || "").trim();
  if (!normalizedBlockId) return [];
  return CHECKPOINTS
    .filter((entry) => entry.strategy_block_id === normalizedBlockId)
    .map((entry) => ({ ...entry }));
}

export function isCruiseFixedCheckpointStage(stageRound) {
  return Boolean(cruiseCheckpointForStage(stageRound));
}

export function cruiseCheckpointAgendaSnapshot() {
  return CHECKPOINTS.map((entry) => ({ ...entry }));
}

export function cruiseConditionalCheckpointSnapshot() {
  return CONDITIONAL_CHECKPOINTS.map((entry) => ({
    ...entry,
    answer_contract: {
      ...entry.answer_contract,
      required_decisions: [...entry.answer_contract.required_decisions],
      supporting_decisions: [...entry.answer_contract.supporting_decisions],
    },
  }));
}

export function cruiseRecoveryStageSnapshot() {
  return RECOVERY_STAGES.map((entry) => ({
    ...entry,
    recovers_checkpoint_ids: [...entry.recovers_checkpoint_ids],
  }));
}

export function cruiseCheckpointsAtOrBefore(stageRound) {
  const currentOrder = stageOrder(stageRound);
  if (currentOrder < 0) return [];
  return CHECKPOINTS
    .filter((entry) => stageOrder(entry.stage_round) <= currentOrder)
    .map((entry) => ({ ...entry }));
}

export const CRUISE_CHECKPOINT_AGENDA_SCHEMA = "jcc-cruise-fixed-checkpoint-agenda-v2";
