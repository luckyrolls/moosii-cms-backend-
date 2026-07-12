export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "12.2.3 (519615d)"
  }
  public: {
    Tables: {
      _segment_dedupe_backup: {
        Row: {
          cards: number | null
          detached_at: string
          old_lesson_id: string
          seg_status: string | null
          segment_id: string
        }
        Insert: {
          cards?: number | null
          detached_at?: string
          old_lesson_id: string
          seg_status?: string | null
          segment_id: string
        }
        Update: {
          cards?: number | null
          detached_at?: string
          old_lesson_id?: string
          seg_status?: string | null
          segment_id?: string
        }
        Relationships: []
      }
      account_types: {
        Row: {
          created_at: string | null
          id: string
          is_system: boolean | null
          name: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_system?: boolean | null
          name: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_system?: boolean | null
          name?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_types_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      accounts: {
        Row: {
          balance_iqd: number | null
          balance_usd: number | null
          created_at: string | null
          id: string
          is_favorite: boolean | null
          is_system: boolean | null
          name: string
          phone: string | null
          type: string
          type_id: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          balance_iqd?: number | null
          balance_usd?: number | null
          created_at?: string | null
          id?: string
          is_favorite?: boolean | null
          is_system?: boolean | null
          name: string
          phone?: string | null
          type: string
          type_id?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          balance_iqd?: number | null
          balance_usd?: number | null
          created_at?: string | null
          id?: string
          is_favorite?: boolean | null
          is_system?: boolean | null
          name?: string
          phone?: string | null
          type?: string
          type_id?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_type_id_fkey"
            columns: ["type_id"]
            isOneToOne: false
            referencedRelation: "account_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      admin: {
        Row: {
          admin_email: string | null
          created_at: string
          id: number
          updated_at: string | null
        }
        Insert: {
          admin_email?: string | null
          created_at?: string
          id?: number
          updated_at?: string | null
        }
        Update: {
          admin_email?: string | null
          created_at?: string
          id?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      age_track_weights: {
        Row: {
          age_bracket: string
          max_months: number | null
          min_months: number | null
          track_id: string
          updated_at: string | null
          weight: number | null
        }
        Insert: {
          age_bracket: string
          max_months?: number | null
          min_months?: number | null
          track_id: string
          updated_at?: string | null
          weight?: number | null
        }
        Update: {
          age_bracket?: string
          max_months?: number | null
          min_months?: number | null
          track_id?: string
          updated_at?: string | null
          weight?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "age_track_weights_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "age_track_weights_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      ai_generation_log: {
        Row: {
          blocks: Json | null
          correlation_id: string | null
          created_at: string
          id: string
          latency_ms: number | null
          model: string | null
          notes: string | null
          operation: string
          prompt: string
          related_entity_id: string | null
          related_entity_type: string | null
          response: Json
        }
        Insert: {
          blocks?: Json | null
          correlation_id?: string | null
          created_at?: string
          id?: string
          latency_ms?: number | null
          model?: string | null
          notes?: string | null
          operation: string
          prompt: string
          related_entity_id?: string | null
          related_entity_type?: string | null
          response: Json
        }
        Update: {
          blocks?: Json | null
          correlation_id?: string | null
          created_at?: string
          id?: string
          latency_ms?: number | null
          model?: string | null
          notes?: string | null
          operation?: string
          prompt?: string
          related_entity_id?: string | null
          related_entity_type?: string | null
          response?: Json
        }
        Relationships: []
      }
      answers_legacy: {
        Row: {
          answer_text: string | null
          created_at: string
          id: string
          is_correct: boolean | null
          question_id: string | null
          response: string | null
          score: number | null
          updated_at: string | null
        }
        Insert: {
          answer_text?: string | null
          created_at?: string
          id?: string
          is_correct?: boolean | null
          question_id?: string | null
          response?: string | null
          score?: number | null
          updated_at?: string | null
        }
        Update: {
          answer_text?: string | null
          created_at?: string
          id?: string
          is_correct?: boolean | null
          question_id?: string | null
          response?: string | null
          score?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions_legacy"
            referencedColumns: ["id"]
          },
        ]
      }
      articles: {
        Row: {
          author_name: string | null
          content: string | null
          created_at: string
          id: string
          image_blurhash: string | null
          image_url: string | null
          subtitle: string | null
          title: string | null
          updated_at: string | null
        }
        Insert: {
          author_name?: string | null
          content?: string | null
          created_at?: string
          id?: string
          image_blurhash?: string | null
          image_url?: string | null
          subtitle?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          author_name?: string | null
          content?: string | null
          created_at?: string
          id?: string
          image_blurhash?: string | null
          image_url?: string | null
          subtitle?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      chat: {
        Row: {
          a_last_seen_message_id: string | null
          b_last_seen_message_id: string | null
          created_at: string
          id: string
          last_message_id: string | null
          Typing_id: string | null
          updated_at: string | null
          user_a_id: string
          user_b_id: string
        }
        Insert: {
          a_last_seen_message_id?: string | null
          b_last_seen_message_id?: string | null
          created_at?: string
          id?: string
          last_message_id?: string | null
          Typing_id?: string | null
          updated_at?: string | null
          user_a_id: string
          user_b_id: string
        }
        Update: {
          a_last_seen_message_id?: string | null
          b_last_seen_message_id?: string | null
          created_at?: string
          id?: string
          last_message_id?: string | null
          Typing_id?: string | null
          updated_at?: string | null
          user_a_id?: string
          user_b_id?: string
        }
        Relationships: []
      }
      child_milestones: {
        Row: {
          child_id: string
          confidence: number | null
          created_at: string
          first_reported_at: string
          id: string
          milestone_id: string
          source: string
          source_ref: string | null
        }
        Insert: {
          child_id: string
          confidence?: number | null
          created_at?: string
          first_reported_at?: string
          id?: string
          milestone_id: string
          source: string
          source_ref?: string | null
        }
        Update: {
          child_id?: string
          confidence?: number | null
          created_at?: string
          first_reported_at?: string
          id?: string
          milestone_id?: string
          source?: string
          source_ref?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "child_milestones_milestone_id_fkey"
            columns: ["milestone_id"]
            isOneToOne: false
            referencedRelation: "milestones"
            referencedColumns: ["id"]
          },
        ]
      }
      children: {
        Row: {
          birth_month: number | null
          birth_year: number | null
          created_at: string
          gender: string | null
          id: string
          nickname: string | null
          parent_id: string | null
          updated_at: string | null
        }
        Insert: {
          birth_month?: number | null
          birth_year?: number | null
          created_at?: string
          gender?: string | null
          id?: string
          nickname?: string | null
          parent_id?: string | null
          updated_at?: string | null
        }
        Update: {
          birth_month?: number | null
          birth_year?: number | null
          created_at?: string
          gender?: string | null
          id?: string
          nickname?: string | null
          parent_id?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      comments: {
        Row: {
          comment: string | null
          created_at: string
          created_by: string | null
          deleted: boolean
          group_id: string | null
          id: string
          post_id: string | null
          updated_at: string | null
        }
        Insert: {
          comment?: string | null
          created_at?: string
          created_by?: string | null
          deleted?: boolean
          group_id?: string | null
          id?: string
          post_id?: string | null
          updated_at?: string | null
        }
        Update: {
          comment?: string | null
          created_at?: string
          created_by?: string | null
          deleted?: boolean
          group_id?: string | null
          id?: string
          post_id?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      completed_items: {
        Row: {
          abbreviated_title: string | null
          created_at: string
          id: number
          item_description: string
          item_id: string | null
          item_name: string
          item_type: string | null
          lesson_id: string | null
          questionnaire_id: string | null
          score: number
          task_image: string | null
          updated_at: string | null
          user_id: string
          with_quiz: boolean
        }
        Insert: {
          abbreviated_title?: string | null
          created_at?: string
          id?: number
          item_description?: string
          item_id?: string | null
          item_name?: string
          item_type?: string | null
          lesson_id?: string | null
          questionnaire_id?: string | null
          score?: number
          task_image?: string | null
          updated_at?: string | null
          user_id: string
          with_quiz?: boolean
        }
        Update: {
          abbreviated_title?: string | null
          created_at?: string
          id?: number
          item_description?: string
          item_id?: string | null
          item_name?: string
          item_type?: string | null
          lesson_id?: string | null
          questionnaire_id?: string | null
          score?: number
          task_image?: string | null
          updated_at?: string | null
          user_id?: string
          with_quiz?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "completed_items_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "completed_items_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completed_items_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completed_items_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completed_items_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "completed_items_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completed_items_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      consts: {
        Row: {
          daily_limit: number | null
          free_trial_days: number
          id: number
          mlp_limit: number | null
          monthly_fee: number
          moosi_to_add: number
          updated_at: string | null
          weight_factor: number | null
          yearly_fee: number
        }
        Insert: {
          daily_limit?: number | null
          free_trial_days?: number
          id?: number
          mlp_limit?: number | null
          monthly_fee?: number
          moosi_to_add: number
          updated_at?: string | null
          weight_factor?: number | null
          yearly_fee?: number
        }
        Update: {
          daily_limit?: number | null
          free_trial_days?: number
          id?: number
          mlp_limit?: number | null
          monthly_fee?: number
          moosi_to_add?: number
          updated_at?: string | null
          weight_factor?: number | null
          yearly_fee?: number
        }
        Relationships: []
      }
      content_findings: {
        Row: {
          addressed_at: string | null
          addressed_by: string | null
          category: string | null
          claim_quote: string | null
          correlation_id: string
          created_at: string
          dismissed_at: string | null
          dismissed_by: string | null
          finding: string
          finding_kind: string | null
          id: string
          lesson_id: string
          review_type: string
          severity: string
          source_document_id: string | null
          source_passage: string | null
          source_version_label: string | null
          status: string
          sub_segment_id: string | null
        }
        Insert: {
          addressed_at?: string | null
          addressed_by?: string | null
          category?: string | null
          claim_quote?: string | null
          correlation_id: string
          created_at?: string
          dismissed_at?: string | null
          dismissed_by?: string | null
          finding: string
          finding_kind?: string | null
          id?: string
          lesson_id: string
          review_type: string
          severity?: string
          source_document_id?: string | null
          source_passage?: string | null
          source_version_label?: string | null
          status?: string
          sub_segment_id?: string | null
        }
        Update: {
          addressed_at?: string | null
          addressed_by?: string | null
          category?: string | null
          claim_quote?: string | null
          correlation_id?: string
          created_at?: string
          dismissed_at?: string | null
          dismissed_by?: string | null
          finding?: string
          finding_kind?: string | null
          id?: string
          lesson_id?: string
          review_type?: string
          severity?: string
          source_document_id?: string | null
          source_passage?: string | null
          source_version_label?: string | null
          status?: string
          sub_segment_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "content_findings_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "content_findings_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_findings_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_findings_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_findings_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "content_findings_source_document_id_fkey"
            columns: ["source_document_id"]
            isOneToOne: false
            referencedRelation: "source_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_findings_sub_segment_id_fkey"
            columns: ["sub_segment_id"]
            isOneToOne: false
            referencedRelation: "sub_segment_image_fallback"
            referencedColumns: ["sub_segment_id"]
          },
          {
            foreignKeyName: "content_findings_sub_segment_id_fkey"
            columns: ["sub_segment_id"]
            isOneToOne: false
            referencedRelation: "sub_segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_findings_sub_segment_id_fkey"
            columns: ["sub_segment_id"]
            isOneToOne: false
            referencedRelation: "sub_segments_image_fallback"
            referencedColumns: ["sub_segment_id"]
          },
        ]
      }
      content_images: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          final_prompt: string
          id: string
          image_generator_name: string
          image_generator_version: string | null
          image_prompt: string
          instruction_version_base: string | null
          instruction_version_overlay: string | null
          job_id: string | null
          lesson_id: string | null
          name: string | null
          prompt_writer_name: string | null
          prompt_writer_version: string | null
          scene: string | null
          segment_id: string | null
          status: string
          storage_path: string
          sub_segment_id: string | null
          tags: string[]
          topic_name: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          final_prompt: string
          id?: string
          image_generator_name: string
          image_generator_version?: string | null
          image_prompt: string
          instruction_version_base?: string | null
          instruction_version_overlay?: string | null
          job_id?: string | null
          lesson_id?: string | null
          name?: string | null
          prompt_writer_name?: string | null
          prompt_writer_version?: string | null
          scene?: string | null
          segment_id?: string | null
          status?: string
          storage_path: string
          sub_segment_id?: string | null
          tags?: string[]
          topic_name?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          final_prompt?: string
          id?: string
          image_generator_name?: string
          image_generator_version?: string | null
          image_prompt?: string
          instruction_version_base?: string | null
          instruction_version_overlay?: string | null
          job_id?: string | null
          lesson_id?: string | null
          name?: string | null
          prompt_writer_name?: string | null
          prompt_writer_version?: string | null
          scene?: string | null
          segment_id?: string | null
          status?: string
          storage_path?: string
          sub_segment_id?: string | null
          tags?: string[]
          topic_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "content_images_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_images_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "content_images_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_images_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_images_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_images_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "content_images_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_segment_id"]
          },
          {
            foreignKeyName: "content_images_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_images_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "user_segment_progress"
            referencedColumns: ["segment_id"]
          },
          {
            foreignKeyName: "content_images_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "v_segment_details"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_images_sub_segment_id_fkey"
            columns: ["sub_segment_id"]
            isOneToOne: false
            referencedRelation: "sub_segment_image_fallback"
            referencedColumns: ["sub_segment_id"]
          },
          {
            foreignKeyName: "content_images_sub_segment_id_fkey"
            columns: ["sub_segment_id"]
            isOneToOne: false
            referencedRelation: "sub_segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_images_sub_segment_id_fkey"
            columns: ["sub_segment_id"]
            isOneToOne: false
            referencedRelation: "sub_segments_image_fallback"
            referencedColumns: ["sub_segment_id"]
          },
        ]
      }
      content_size_profiles: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          label: string | null
          max_bullet_words: number | null
          max_bullets_per_card: number | null
          max_sentence_words: number | null
          name: string
          total_words_max: number | null
          total_words_min: number | null
          updated_at: string
          words_per_card_max: number | null
          words_per_card_min: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string | null
          max_bullet_words?: number | null
          max_bullets_per_card?: number | null
          max_sentence_words?: number | null
          name: string
          total_words_max?: number | null
          total_words_min?: number | null
          updated_at?: string
          words_per_card_max?: number | null
          words_per_card_min?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string | null
          max_bullet_words?: number | null
          max_bullets_per_card?: number | null
          max_sentence_words?: number | null
          name?: string
          total_words_max?: number | null
          total_words_min?: number | null
          updated_at?: string
          words_per_card_max?: number | null
          words_per_card_min?: number | null
        }
        Relationships: []
      }
      continue_streak: {
        Row: {
          created_at: string
          id: string
          template_text: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          template_text?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          template_text?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      demographic_answers: {
        Row: {
          answer_key: string | null
          created_at: string
          display_text: string
          id: string
          is_active: boolean
          question_id: string
          sort_order: number
          updated_at: string | null
        }
        Insert: {
          answer_key?: string | null
          created_at?: string
          display_text: string
          id?: string
          is_active?: boolean
          question_id: string
          sort_order?: number
          updated_at?: string | null
        }
        Update: {
          answer_key?: string | null
          created_at?: string
          display_text?: string
          id?: string
          is_active?: boolean
          question_id?: string
          sort_order?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "demographic_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "demographic_questions"
            referencedColumns: ["id"]
          },
        ]
      }
      demographic_questions: {
        Row: {
          created_at: string
          help_text: string | null
          id: string
          is_active: boolean
          prompt_text: string
          question_key: string
          sort_order: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          help_text?: string | null
          id?: string
          is_active?: boolean
          prompt_text: string
          question_key: string
          sort_order?: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          help_text?: string | null
          id?: string
          is_active?: boolean
          prompt_text?: string
          question_key?: string
          sort_order?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      demographic_track_rules: {
        Row: {
          answer_id: string
          created_at: string
          id: string
          track_id: string
        }
        Insert: {
          answer_id: string
          created_at?: string
          id?: string
          track_id: string
        }
        Update: {
          answer_id?: string
          created_at?: string
          id?: string
          track_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "demographic_track_rules_answer_id_fkey"
            columns: ["answer_id"]
            isOneToOne: false
            referencedRelation: "demographic_answers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demographic_track_rules_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demographic_track_rules_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      distress_detections: {
        Row: {
          child_id: string | null
          correlation_id: string | null
          created_at: string
          event_id: string | null
          evidence_span: string | null
          id: string
          parse_failed: boolean
          tier: string
          user_id: string
        }
        Insert: {
          child_id?: string | null
          correlation_id?: string | null
          created_at?: string
          event_id?: string | null
          evidence_span?: string | null
          id?: string
          parse_failed?: boolean
          tier: string
          user_id: string
        }
        Update: {
          child_id?: string | null
          correlation_id?: string | null
          created_at?: string
          event_id?: string | null
          evidence_span?: string | null
          id?: string
          parse_failed?: boolean
          tier?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "distress_detections_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "user_update_events"
            referencedColumns: ["id"]
          },
        ]
      }
      distress_responses: {
        Row: {
          created_at: string
          id: string
          is_provisional: boolean
          message: string
          resources: Json
          tier: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_provisional?: boolean
          message: string
          resources?: Json
          tier: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_provisional?: boolean
          message?: string
          resources?: Json
          tier?: string
          updated_at?: string
        }
        Relationships: []
      }
      faqs: {
        Row: {
          answer: string | null
          created_at: string
          id: string
          question: string | null
          updated_at: string | null
        }
        Insert: {
          answer?: string | null
          created_at?: string
          id?: string
          question?: string | null
          updated_at?: string | null
        }
        Update: {
          answer?: string | null
          created_at?: string
          id?: string
          question?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      free_trial: {
        Row: {
          created_at: string
          day_duration: number
          end_day: string
          start_day: string
          updated_at: string | null
          user_email: string
        }
        Insert: {
          created_at?: string
          day_duration: number
          end_day: string
          start_day: string
          updated_at?: string | null
          user_email: string
        }
        Update: {
          created_at?: string
          day_duration?: number
          end_day?: string
          start_day?: string
          updated_at?: string | null
          user_email?: string
        }
        Relationships: []
      }
      friends: {
        Row: {
          created_at: string
          id: string
          is_accepted: boolean
          updated_at: string | null
          user_a: string
          user_b: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_accepted?: boolean
          updated_at?: string | null
          user_a: string
          user_b: string
        }
        Update: {
          created_at?: string
          id?: string
          is_accepted?: boolean
          updated_at?: string | null
          user_a?: string
          user_b?: string
        }
        Relationships: [
          {
            foreignKeyName: "friends_user_a_fkey"
            columns: ["user_a"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "friends_user_a_fkey"
            columns: ["user_a"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friends_user_a_fkey"
            columns: ["user_a"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "friends_user_b_fkey"
            columns: ["user_b"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "friends_user_b_fkey"
            columns: ["user_b"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friends_user_b_fkey"
            columns: ["user_b"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      group_chat: {
        Row: {
          created_at: string
          creator_id: string
          group_name: string | null
          id: string
          last_message_id: string | null
          Typing_id: string | null
          updated_at: string | null
          users_ids: string[] | null
        }
        Insert: {
          created_at?: string
          creator_id: string
          group_name?: string | null
          id?: string
          last_message_id?: string | null
          Typing_id?: string | null
          updated_at?: string | null
          users_ids?: string[] | null
        }
        Update: {
          created_at?: string
          creator_id?: string
          group_name?: string | null
          id?: string
          last_message_id?: string | null
          Typing_id?: string | null
          updated_at?: string | null
          users_ids?: string[] | null
        }
        Relationships: []
      }
      group_chat_user_last_seen: {
        Row: {
          chat_id: string | null
          id: string
          last_seen_message_id: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          chat_id?: string | null
          id?: string
          last_seen_message_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          chat_id?: string | null
          id?: string
          last_seen_message_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      group_member: {
        Row: {
          created_at: string
          group_id: string
          id: number
          role: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          group_id: string
          id?: number
          role: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          group_id?: string
          id?: number
          role?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_member_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_member_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups_data"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_member_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_member_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "user_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_member_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "group_member_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_member_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      group_message: {
        Row: {
          created_at: string
          group_chat_id: string | null
          id: string
          media_link: string | null
          sender_id: string | null
          text: string | null
          type: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          group_chat_id?: string | null
          id?: string
          media_link?: string | null
          sender_id?: string | null
          text?: string | null
          type?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          group_chat_id?: string | null
          id?: string
          media_link?: string | null
          sender_id?: string | null
          text?: string | null
          type?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "group_message_group_chat_id_fkey"
            columns: ["group_chat_id"]
            isOneToOne: false
            referencedRelation: "group_chat"
            referencedColumns: ["id"]
          },
        ]
      }
      groups_data: {
        Row: {
          admin_id: string | null
          allow_all: boolean | null
          birth_month: number | null
          birth_year: number | null
          children_count: number | null
          created_at: string
          created_by: string | null
          description: string | null
          gender: string[] | null
          group_name: string | null
          id: string
          image_blur_hash: string | null
          image_url: string | null
          is_suggested: boolean | null
          marital_status: string[] | null
          updated_at: string | null
        }
        Insert: {
          admin_id?: string | null
          allow_all?: boolean | null
          birth_month?: number | null
          birth_year?: number | null
          children_count?: number | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          gender?: string[] | null
          group_name?: string | null
          id?: string
          image_blur_hash?: string | null
          image_url?: string | null
          is_suggested?: boolean | null
          marital_status?: string[] | null
          updated_at?: string | null
        }
        Update: {
          admin_id?: string | null
          allow_all?: boolean | null
          birth_month?: number | null
          birth_year?: number | null
          children_count?: number | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          gender?: string[] | null
          group_name?: string | null
          id?: string
          image_blur_hash?: string | null
          image_url?: string | null
          is_suggested?: boolean | null
          marital_status?: string[] | null
          updated_at?: string | null
        }
        Relationships: []
      }
      image_assets: {
        Row: {
          bucket: string
          created_at: string
          id: string
          name: string
          path: string
          prompt: string | null
          updated_at: string
          url: string | null
        }
        Insert: {
          bucket: string
          created_at?: string
          id?: string
          name: string
          path: string
          prompt?: string | null
          updated_at?: string
          url?: string | null
        }
        Update: {
          bucket?: string
          created_at?: string
          id?: string
          name?: string
          path?: string
          prompt?: string | null
          updated_at?: string
          url?: string | null
        }
        Relationships: []
      }
      invitees: {
        Row: {
          created_at: string
          email: string | null
          id: string
          invited_by: string | null
          role: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          invited_by?: string | null
          role?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          invited_by?: string | null
          role?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      jobs: {
        Row: {
          created_at: string
          error: Json | null
          finished_at: string | null
          id: string
          input: Json
          result: Json | null
          started_at: string | null
          status: string
          type: string
        }
        Insert: {
          created_at?: string
          error?: Json | null
          finished_at?: string | null
          id?: string
          input?: Json
          result?: Json | null
          started_at?: string | null
          status?: string
          type: string
        }
        Update: {
          created_at?: string
          error?: Json | null
          finished_at?: string | null
          id?: string
          input?: Json
          result?: Json | null
          started_at?: string | null
          status?: string
          type?: string
        }
        Relationships: []
      }
      lesson_source_documents: {
        Row: {
          created_at: string
          lesson_id: string
          source_document_id: string
        }
        Insert: {
          created_at?: string
          lesson_id: string
          source_document_id: string
        }
        Update: {
          created_at?: string
          lesson_id?: string
          source_document_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lesson_source_documents_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "lesson_source_documents_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_source_documents_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_source_documents_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_source_documents_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "lesson_source_documents_source_document_id_fkey"
            columns: ["source_document_id"]
            isOneToOne: false
            referencedRelation: "source_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      lesson_tags: {
        Row: {
          created_at: string
          id: string
          lesson_id: string | null
          tag_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          lesson_id?: string | null
          tag_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          lesson_id?: string | null
          tag_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lesson_tags_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "lesson_tags_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_tags_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_tags_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_tags_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "lesson_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_tag_details"
            referencedColumns: ["tag_id"]
          },
        ]
      }
      lessons: {
        Row: {
          abbreviated_title: string
          article: string | null
          band_rationale: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          image_url: string | null
          is_published: boolean | null
          lesson_name: string | null
          max_child_age: number | null
          max_questionnaire_score_range: number | null
          min_child_age: number | null
          min_questionnaire_score_range: number | null
          points: number | null
          priority: number | null
          published_by: string | null
          quiz_onboarding_image: string
          quiz_onboarding_text: string
          safety_sensitive: boolean
          segment_status: string | null
          status: string | null
          task_image: string | null
          time: number | null
          topic_id: string | null
          track_id: string | null
          updated_at: string | null
          updated_by: string | null
          with_quiz: boolean
        }
        Insert: {
          abbreviated_title?: string
          article?: string | null
          band_rationale?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_published?: boolean | null
          lesson_name?: string | null
          max_child_age?: number | null
          max_questionnaire_score_range?: number | null
          min_child_age?: number | null
          min_questionnaire_score_range?: number | null
          points?: number | null
          priority?: number | null
          published_by?: string | null
          quiz_onboarding_image?: string
          quiz_onboarding_text?: string
          safety_sensitive?: boolean
          segment_status?: string | null
          status?: string | null
          task_image?: string | null
          time?: number | null
          topic_id?: string | null
          track_id?: string | null
          updated_at?: string | null
          updated_by?: string | null
          with_quiz?: boolean
        }
        Update: {
          abbreviated_title?: string
          article?: string | null
          band_rationale?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_published?: boolean | null
          lesson_name?: string | null
          max_child_age?: number | null
          max_questionnaire_score_range?: number | null
          min_child_age?: number | null
          min_questionnaire_score_range?: number | null
          points?: number | null
          priority?: number | null
          published_by?: string | null
          quiz_onboarding_image?: string
          quiz_onboarding_text?: string
          safety_sensitive?: boolean
          segment_status?: string | null
          status?: string | null
          task_image?: string | null
          time?: number | null
          topic_id?: string | null
          track_id?: string | null
          updated_at?: string | null
          updated_by?: string | null
          with_quiz?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "lessons_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lessons_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lessons_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      message: {
        Row: {
          chat_id: string | null
          created_at: string
          id: string
          media_link: string | null
          sender_id: string | null
          text: string | null
          type: string | null
          updated_at: string | null
        }
        Insert: {
          chat_id?: string | null
          created_at?: string
          id?: string
          media_link?: string | null
          sender_id?: string | null
          text?: string | null
          type?: string | null
          updated_at?: string | null
        }
        Update: {
          chat_id?: string | null
          created_at?: string
          id?: string
          media_link?: string | null
          sender_id?: string | null
          text?: string | null
          type?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "Message_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "chat"
            referencedColumns: ["id"]
          },
        ]
      }
      milestones: {
        Row: {
          created_at: string
          id: string
          label: string | null
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          name?: string
        }
        Relationships: []
      }
      new_user_tracks: {
        Row: {
          created_at: string
          id: string
          track_id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          track_id: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          track_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "new_user_tracks_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "new_user_tracks_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      notification_log: {
        Row: {
          fcm_token: string | null
          id: number
          message_body: string | null
          response_json: Json | null
          status: string | null
          timestamp: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          fcm_token?: string | null
          id?: number
          message_body?: string | null
          response_json?: Json | null
          status?: string | null
          timestamp?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          fcm_token?: string | null
          id?: number
          message_body?: string | null
          response_json?: Json | null
          status?: string | null
          timestamp?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "notification_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          is_saw: boolean | null
          title: string | null
          type: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          is_saw?: boolean | null
          title?: string | null
          type?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          is_saw?: boolean | null
          title?: string | null
          type?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "Notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "Notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "Notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      onboarding_photos: {
        Row: {
          created_at: string
          id: number
          link: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          id?: number
          link: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          id?: number
          link?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      payment_history: {
        Row: {
          amount: number
          created_at: string | null
          currency: string
          id: string
          payment_method: string | null
          payment_reference: string | null
          plan_id: string
          status: string | null
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string | null
          currency: string
          id?: string
          payment_method?: string | null
          payment_reference?: string | null
          plan_id: string
          status?: string | null
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string | null
          currency?: string
          id?: string
          payment_method?: string | null
          payment_reference?: string | null
          plan_id?: string
          status?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_history_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_history_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          created_at: string
          created_by: string | null
          deleted: boolean
          group_id: string | null
          id: string
          image_blur_hash: string[] | null
          image_url: string[] | null
          is_feed: boolean | null
          likes: string[] | null
          post_text: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted?: boolean
          group_id?: string | null
          id?: string
          image_blur_hash?: string[] | null
          image_url?: string[] | null
          is_feed?: boolean | null
          likes?: string[] | null
          post_text?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted?: boolean
          group_id?: string | null
          id?: string
          image_blur_hash?: string[] | null
          image_url?: string[] | null
          is_feed?: boolean | null
          likes?: string[] | null
          post_text?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "posts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "posts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          company_name: string
          created_at: string | null
          default_currency: string | null
          id: string
          phone: string
          subscription_end_date: string | null
          subscription_status:
            | Database["public"]["Enums"]["subscription_status"]
            | null
          updated_at: string | null
          username: string
        }
        Insert: {
          avatar_url?: string | null
          company_name: string
          created_at?: string | null
          default_currency?: string | null
          id: string
          phone: string
          subscription_end_date?: string | null
          subscription_status?:
            | Database["public"]["Enums"]["subscription_status"]
            | null
          updated_at?: string | null
          username: string
        }
        Update: {
          avatar_url?: string | null
          company_name?: string
          created_at?: string | null
          default_currency?: string | null
          id?: string
          phone?: string
          subscription_end_date?: string | null
          subscription_status?:
            | Database["public"]["Enums"]["subscription_status"]
            | null
          updated_at?: string | null
          username?: string
        }
        Relationships: []
      }
      prompt_block_versions: {
        Row: {
          block_id: string
          content: string
          created_at: string
          edited_by: string | null
          id: string
        }
        Insert: {
          block_id: string
          content: string
          created_at?: string
          edited_by?: string | null
          id?: string
        }
        Update: {
          block_id?: string
          content?: string
          created_at?: string
          edited_by?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prompt_block_versions_block_id_fkey"
            columns: ["block_id"]
            isOneToOne: false
            referencedRelation: "prompt_blocks"
            referencedColumns: ["id"]
          },
        ]
      }
      prompt_blocks: {
        Row: {
          block_type: string
          content: string
          created_at: string
          id: string
          is_active: boolean
          label: string | null
          name: string
          updated_at: string
        }
        Insert: {
          block_type: string
          content: string
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string | null
          name: string
          updated_at?: string
        }
        Update: {
          block_type?: string
          content?: string
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string | null
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      prompts: {
        Row: {
          card_positions_block_id: string | null
          created_at: string
          default: boolean | null
          id: string
          is_active: boolean
          length_block_id: string | null
          max_tokens: number | null
          model: string | null
          output_schema: Json | null
          prompt_type: string | null
          question_count: number
          scope: string | null
          size_profile_id: string | null
          structure_block_id: string | null
          system_message: string | null
          temperature: number | null
          tone: string | null
          tone_block_id: string | null
          updated_at: string | null
        }
        Insert: {
          card_positions_block_id?: string | null
          created_at?: string
          default?: boolean | null
          id?: string
          is_active?: boolean
          length_block_id?: string | null
          max_tokens?: number | null
          model?: string | null
          output_schema?: Json | null
          prompt_type?: string | null
          question_count?: number
          scope?: string | null
          size_profile_id?: string | null
          structure_block_id?: string | null
          system_message?: string | null
          temperature?: number | null
          tone?: string | null
          tone_block_id?: string | null
          updated_at?: string | null
        }
        Update: {
          card_positions_block_id?: string | null
          created_at?: string
          default?: boolean | null
          id?: string
          is_active?: boolean
          length_block_id?: string | null
          max_tokens?: number | null
          model?: string | null
          output_schema?: Json | null
          prompt_type?: string | null
          question_count?: number
          scope?: string | null
          size_profile_id?: string | null
          structure_block_id?: string | null
          system_message?: string | null
          temperature?: number | null
          tone?: string | null
          tone_block_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "prompts_card_positions_block_id_fkey"
            columns: ["card_positions_block_id"]
            isOneToOne: false
            referencedRelation: "prompt_blocks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prompts_length_block_id_fkey"
            columns: ["length_block_id"]
            isOneToOne: false
            referencedRelation: "prompt_blocks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prompts_size_profile_id_fkey"
            columns: ["size_profile_id"]
            isOneToOne: false
            referencedRelation: "content_size_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prompts_structure_block_id_fkey"
            columns: ["structure_block_id"]
            isOneToOne: false
            referencedRelation: "prompt_blocks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prompts_tone_block_id_fkey"
            columns: ["tone_block_id"]
            isOneToOne: false
            referencedRelation: "prompt_blocks"
            referencedColumns: ["id"]
          },
        ]
      }
      questionnaire: {
        Row: {
          age: number | null
          created_at: string
          description: string | null
          id: string
          is_published: boolean | null
          is_score_based: boolean | null
          milestone_id: string | null
          onboarding_image: string
          onboarding_text: string
          points: number | null
          priority: number | null
          questionnaire_name: string | null
          task_image: string | null
          topic_id: string | null
          track_id: string
          updated_at: string | null
          with_quiz: boolean | null
        }
        Insert: {
          age?: number | null
          created_at?: string
          description?: string | null
          id?: string
          is_published?: boolean | null
          is_score_based?: boolean | null
          milestone_id?: string | null
          onboarding_image?: string
          onboarding_text?: string
          points?: number | null
          priority?: number | null
          questionnaire_name?: string | null
          task_image?: string | null
          topic_id?: string | null
          track_id: string
          updated_at?: string | null
          with_quiz?: boolean | null
        }
        Update: {
          age?: number | null
          created_at?: string
          description?: string | null
          id?: string
          is_published?: boolean | null
          is_score_based?: boolean | null
          milestone_id?: string | null
          onboarding_image?: string
          onboarding_text?: string
          points?: number | null
          priority?: number | null
          questionnaire_name?: string | null
          task_image?: string | null
          topic_id?: string | null
          track_id?: string
          updated_at?: string | null
          with_quiz?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "questionnaire_milestone_id_fkey"
            columns: ["milestone_id"]
            isOneToOne: false
            referencedRelation: "milestones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      questionnaire_answers: {
        Row: {
          answer_text: string | null
          created_at: string
          id: string
          question_id: string | null
          response: string | null
          score: number | null
          updated_at: string | null
        }
        Insert: {
          answer_text?: string | null
          created_at?: string
          id?: string
          question_id?: string | null
          response?: string | null
          score?: number | null
          updated_at?: string | null
        }
        Update: {
          answer_text?: string | null
          created_at?: string
          id?: string
          question_id?: string | null
          response?: string | null
          score?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "questionnaire_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questionnaire_questions"
            referencedColumns: ["question_id"]
          },
        ]
      }
      questionnaire_questions: {
        Row: {
          answer_status: string | null
          created_at: string
          image_url: string | null
          question_id: string
          question_text: string | null
          questionnaire_id: string | null
          type: string | null
          updated_at: string | null
        }
        Insert: {
          answer_status?: string | null
          created_at?: string
          image_url?: string | null
          question_id?: string
          question_text?: string | null
          questionnaire_id?: string | null
          type?: string | null
          updated_at?: string | null
        }
        Update: {
          answer_status?: string | null
          created_at?: string
          image_url?: string | null
          question_id?: string
          question_text?: string | null
          questionnaire_id?: string | null
          type?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "questionnaire_questions_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_questions_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire_with_track_name"
            referencedColumns: ["id"]
          },
        ]
      }
      questionnaire_response: {
        Row: {
          add: boolean
          created_at: string
          id: string
          questionnaire_id: string | null
          repeat_after_days: number | null
          response: string | null
          score_max_range: number | null
          score_min_range: number | null
          tag_id: string | null
          track_id: string | null
          updated_at: string | null
        }
        Insert: {
          add?: boolean
          created_at?: string
          id?: string
          questionnaire_id?: string | null
          repeat_after_days?: number | null
          response?: string | null
          score_max_range?: number | null
          score_min_range?: number | null
          tag_id?: string | null
          track_id?: string | null
          updated_at?: string | null
        }
        Update: {
          add?: boolean
          created_at?: string
          id?: string
          questionnaire_id?: string | null
          repeat_after_days?: number | null
          response?: string | null
          score_max_range?: number | null
          score_min_range?: number | null
          tag_id?: string | null
          track_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "questionnaire_response_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_tag_details"
            referencedColumns: ["tag_id"]
          },
          {
            foreignKeyName: "questionnaire_response_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      questionnaire_user_answers: {
        Row: {
          answer_id: string
          created_at: string
          id: string
          question_id: string
          questionnaire_id: string
          score: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          answer_id: string
          created_at?: string
          id?: string
          question_id: string
          questionnaire_id: string
          score?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          answer_id?: string
          created_at?: string
          id?: string
          question_id?: string
          questionnaire_id?: string
          score?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "questionnaire_user_answers_answer_id_fkey"
            columns: ["answer_id"]
            isOneToOne: false
            referencedRelation: "answers_legacy"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_user_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_user_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions_legacy"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_user_answers_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_user_answers_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_user_answers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "questionnaire_user_answers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_user_answers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      questions_legacy: {
        Row: {
          answer_status: string | null
          created_at: string
          id: string
          image_url: string | null
          item_id: string | null
          item_type: string | null
          lesson_id: string | null
          question_explanation: string | null
          question_text: string | null
          segment_id: string | null
          type: string | null
          updated_at: string | null
        }
        Insert: {
          answer_status?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          item_id?: string | null
          item_type?: string | null
          lesson_id?: string | null
          question_explanation?: string | null
          question_text?: string | null
          segment_id?: string | null
          type?: string | null
          updated_at?: string | null
        }
        Update: {
          answer_status?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          item_id?: string | null
          item_type?: string | null
          lesson_id?: string | null
          question_explanation?: string | null
          question_text?: string | null
          segment_id?: string | null
          type?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "questions_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "questions_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_segment_id"]
          },
          {
            foreignKeyName: "questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "user_segment_progress"
            referencedColumns: ["segment_id"]
          },
          {
            foreignKeyName: "questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "v_segment_details"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_answers: {
        Row: {
          answer_text: string | null
          created_at: string
          id: string
          is_correct: boolean | null
          question_id: string | null
          response: string | null
          score: number | null
          updated_at: string | null
        }
        Insert: {
          answer_text?: string | null
          created_at?: string
          id?: string
          is_correct?: boolean | null
          question_id?: string | null
          response?: string | null
          score?: number | null
          updated_at?: string | null
        }
        Update: {
          answer_text?: string | null
          created_at?: string
          id?: string
          is_correct?: boolean | null
          question_id?: string | null
          response?: string | null
          score?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quiz_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "quiz_questions"
            referencedColumns: ["question_id"]
          },
        ]
      }
      quiz_questions: {
        Row: {
          answer_status: string | null
          created_at: string
          image_url: string | null
          lesson_id: string | null
          question_explanation: string | null
          question_id: string
          question_text: string | null
          segment_id: string | null
          type: string
          updated_at: string | null
        }
        Insert: {
          answer_status?: string | null
          created_at?: string
          image_url?: string | null
          lesson_id?: string | null
          question_explanation?: string | null
          question_id?: string
          question_text?: string | null
          segment_id?: string | null
          type?: string
          updated_at?: string | null
        }
        Update: {
          answer_status?: string | null
          created_at?: string
          image_url?: string | null
          lesson_id?: string | null
          question_explanation?: string | null
          question_id?: string
          question_text?: string | null
          segment_id?: string | null
          type?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quiz_questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_segment_id"]
          },
          {
            foreignKeyName: "quiz_questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "user_segment_progress"
            referencedColumns: ["segment_id"]
          },
          {
            foreignKeyName: "quiz_questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "v_segment_details"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_response: {
        Row: {
          created_at: string
          id: string
          lesson_id: string | null
          response: string | null
          score_max_range: number | null
          score_min_range: number | null
          track_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          lesson_id?: string | null
          response?: string | null
          score_max_range?: number | null
          score_min_range?: number | null
          track_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          lesson_id?: string | null
          response?: string | null
          score_max_range?: number | null
          score_min_range?: number | null
          track_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quiz_response_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "quiz_response_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_response_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_response_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_response_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "quiz_response_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_response_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      quiz_user_progress: {
        Row: {
          answers_ids: string[] | null
          created_at: string
          id: string
          lesson_id: string | null
          question_id: string | null
          updated_at: string | null
        }
        Insert: {
          answers_ids?: string[] | null
          created_at?: string
          id?: string
          lesson_id?: string | null
          question_id?: string | null
          updated_at?: string | null
        }
        Update: {
          answers_ids?: string[] | null
          created_at?: string
          id?: string
          lesson_id?: string | null
          question_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quiz_user_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "quiz_user_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_user_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_user_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_user_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "quiz_user_progress_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "quiz_questions"
            referencedColumns: ["question_id"]
          },
        ]
      }
      recurring_invoices: {
        Row: {
          amount_iqd: number | null
          amount_usd: number | null
          created_at: string | null
          direct_receive: boolean | null
          from_account_id: string
          id: string
          is_active: boolean | null
          last_executed_at: string | null
          next_execution_at: string | null
          note: string | null
          renewal_day: number
          renewal_interval: number | null
          start_month: number
          title: string
          to_account_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          amount_iqd?: number | null
          amount_usd?: number | null
          created_at?: string | null
          direct_receive?: boolean | null
          from_account_id: string
          id?: string
          is_active?: boolean | null
          last_executed_at?: string | null
          next_execution_at?: string | null
          note?: string | null
          renewal_day: number
          renewal_interval?: number | null
          start_month: number
          title: string
          to_account_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          amount_iqd?: number | null
          amount_usd?: number | null
          created_at?: string | null
          direct_receive?: boolean | null
          from_account_id?: string
          id?: string
          is_active?: boolean | null
          last_executed_at?: string | null
          next_execution_at?: string | null
          note?: string | null
          renewal_day?: number
          renewal_interval?: number | null
          start_month?: number
          title?: string
          to_account_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recurring_invoices_from_account_id_fkey"
            columns: ["from_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_invoices_to_account_id_fkey"
            columns: ["to_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_invoices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      replies: {
        Row: {
          comment_id: string | null
          created_at: string
          created_by: string | null
          deleted: boolean
          group_id: string | null
          id: string
          post_id: string | null
          reply_text: string | null
          updated_at: string | null
        }
        Insert: {
          comment_id?: string | null
          created_at?: string
          created_by?: string | null
          deleted?: boolean
          group_id?: string | null
          id?: string
          post_id?: string | null
          reply_text?: string | null
          updated_at?: string | null
        }
        Update: {
          comment_id?: string | null
          created_at?: string
          created_by?: string | null
          deleted?: boolean
          group_id?: string | null
          id?: string
          post_id?: string | null
          reply_text?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      reports: {
        Row: {
          additional_details: string | null
          created_at: string
          id: string
          item_id: string | null
          reason: string | null
          reported_by: string | null
          type: string | null
          updated_at: string | null
          user_name: string | null
        }
        Insert: {
          additional_details?: string | null
          created_at?: string
          id?: string
          item_id?: string | null
          reason?: string | null
          reported_by?: string | null
          type?: string | null
          updated_at?: string | null
          user_name?: string | null
        }
        Update: {
          additional_details?: string | null
          created_at?: string
          id?: string
          item_id?: string | null
          reason?: string | null
          reported_by?: string | null
          type?: string | null
          updated_at?: string | null
          user_name?: string | null
        }
        Relationships: []
      }
      response_templates: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          key: string
          template: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key: string
          template: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key?: string
          template?: string
          updated_at?: string
        }
        Relationships: []
      }
      screen_help: {
        Row: {
          body: string
          id: string
          screen_key: string
          section_key: string | null
          sort_order: number
          title: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          body: string
          id?: string
          screen_key: string
          section_key?: string | null
          sort_order?: number
          title: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          body?: string
          id?: string
          screen_key?: string
          section_key?: string | null
          sort_order?: number
          title?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      segments: {
        Row: {
          anchor_text: string | null
          approved_by: string | null
          chatgpt_image_prompt: string | null
          content: string | null
          created_at: string
          created_by: string | null
          description: string | null
          edited: boolean | null
          full_prompt: string | null
          id: string
          image_prompt: string | null
          image_url: string | null
          laytout_top: string | null
          lesson_id: string | null
          question_id: number | null
          ref_link: string | null
          seg_status: string | null
          segment_name: string | null
          segment_order: number | null
          takeaway: string | null
          title: string | null
          tone: string | null
          updated_at: string | null
          video_url: string | null
        }
        Insert: {
          anchor_text?: string | null
          approved_by?: string | null
          chatgpt_image_prompt?: string | null
          content?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          edited?: boolean | null
          full_prompt?: string | null
          id?: string
          image_prompt?: string | null
          image_url?: string | null
          laytout_top?: string | null
          lesson_id?: string | null
          question_id?: number | null
          ref_link?: string | null
          seg_status?: string | null
          segment_name?: string | null
          segment_order?: number | null
          takeaway?: string | null
          title?: string | null
          tone?: string | null
          updated_at?: string | null
          video_url?: string | null
        }
        Update: {
          anchor_text?: string | null
          approved_by?: string | null
          chatgpt_image_prompt?: string | null
          content?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          edited?: boolean | null
          full_prompt?: string | null
          id?: string
          image_prompt?: string | null
          image_url?: string | null
          laytout_top?: string | null
          lesson_id?: string | null
          question_id?: number | null
          ref_link?: string | null
          seg_status?: string | null
          segment_name?: string | null
          segment_order?: number | null
          takeaway?: string | null
          title?: string | null
          tone?: string | null
          updated_at?: string | null
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
        ]
      }
      source_documents: {
        Row: {
          authority_note: string | null
          body: string
          created_at: string
          id: string
          name: string
          origin_url: string | null
          updated_at: string
          version_label: string
        }
        Insert: {
          authority_note?: string | null
          body: string
          created_at?: string
          id?: string
          name: string
          origin_url?: string | null
          updated_at?: string
          version_label: string
        }
        Update: {
          authority_note?: string | null
          body?: string
          created_at?: string
          id?: string
          name?: string
          origin_url?: string | null
          updated_at?: string
          version_label?: string
        }
        Relationships: []
      }
      starred_items: {
        Row: {
          created_at: string
          id: number
          item_id: string
          lesson_id: string | null
          questionnaire_id: string | null
          updated_at: string | null
          "user id": string | null
        }
        Insert: {
          created_at?: string
          id?: number
          item_id: string
          lesson_id?: string | null
          questionnaire_id?: string | null
          updated_at?: string | null
          "user id"?: string | null
        }
        Update: {
          created_at?: string
          id?: number
          item_id?: string
          lesson_id?: string | null
          questionnaire_id?: string | null
          updated_at?: string | null
          "user id"?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "starred_items_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "starred_items_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "starred_items_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "starred_items_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "starred_items_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "starred_items_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "starred_items_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "starred_items_user id_fkey"
            columns: ["user id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "starred_items_user id_fkey"
            columns: ["user id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "starred_items_user id_fkey"
            columns: ["user id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      start_streak: {
        Row: {
          created_at: string
          id: string
          template_text: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          template_text?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          template_text?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      sub_segments: {
        Row: {
          content: string | null
          created_at: string
          id: string
          image: string | null
          image_path: string | null
          image_prompt: string | null
          layout_top: string | null
          seg_id: string | null
          sequence: number | null
          title: string | null
          tone_id: string | null
        }
        Insert: {
          content?: string | null
          created_at?: string
          id?: string
          image?: string | null
          image_path?: string | null
          image_prompt?: string | null
          layout_top?: string | null
          seg_id?: string | null
          sequence?: number | null
          title?: string | null
          tone_id?: string | null
        }
        Update: {
          content?: string | null
          created_at?: string
          id?: string
          image?: string | null
          image_path?: string | null
          image_prompt?: string | null
          layout_top?: string | null
          seg_id?: string | null
          sequence?: number | null
          title?: string | null
          tone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_segment_id"]
          },
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "user_segment_progress"
            referencedColumns: ["segment_id"]
          },
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "v_segment_details"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sub_segments_image_fkey"
            columns: ["image"]
            isOneToOne: false
            referencedRelation: "image_assets"
            referencedColumns: ["url"]
          },
          {
            foreignKeyName: "sub_segments_tone_id_fkey"
            columns: ["tone_id"]
            isOneToOne: false
            referencedRelation: "prompts"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_plans: {
        Row: {
          created_at: string | null
          description: string | null
          description_ar: string | null
          duration_months: number
          id: string
          is_active: boolean | null
          name: string
          name_ar: string
          price_iqd: number
          price_usd: number
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          description_ar?: string | null
          duration_months: number
          id?: string
          is_active?: boolean | null
          name: string
          name_ar: string
          price_iqd: number
          price_usd: number
        }
        Update: {
          created_at?: string | null
          description?: string | null
          description_ar?: string | null
          duration_months?: number
          id?: string
          is_active?: boolean | null
          name?: string
          name_ar?: string
          price_iqd?: number
          price_usd?: number
        }
        Relationships: []
      }
      tag_item_map: {
        Row: {
          created_at: string
          id: string
          item_id: string | null
          item_type: string | null
          priority: number | null
          tag_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          item_id?: string | null
          item_type?: string | null
          priority?: number | null
          tag_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          item_id?: string | null
          item_type?: string | null
          priority?: number | null
          tag_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tag_item_map_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tag_item_map_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_tag_details"
            referencedColumns: ["tag_id"]
          },
        ]
      }
      tags: {
        Row: {
          created_at: string
          id: string
          last_updated: string | null
          tag_description: string | null
          tag_name: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          last_updated?: string | null
          tag_description?: string | null
          tag_name?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          last_updated?: string | null
          tag_description?: string | null
          tag_name?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      terms_of_service_and_privacy: {
        Row: {
          id: number
          privacy_content: string | null
          privacy_last_update: string
          privacy_title: string | null
          terms_content: string | null
          terms_last_update: string
          terms_title: string | null
          updated_at: string | null
          version: string
        }
        Insert: {
          id?: number
          privacy_content?: string | null
          privacy_last_update?: string
          privacy_title?: string | null
          terms_content?: string | null
          terms_last_update?: string
          terms_title?: string | null
          updated_at?: string | null
          version?: string
        }
        Update: {
          id?: number
          privacy_content?: string | null
          privacy_last_update?: string
          privacy_title?: string | null
          terms_content?: string | null
          terms_last_update?: string
          terms_title?: string | null
          updated_at?: string | null
          version?: string
        }
        Relationships: []
      }
      topics: {
        Row: {
          color: string | null
          created_at: string
          icon_name: string | null
          id: string
          label: string
          name: string
          sort_order: number
        }
        Insert: {
          color?: string | null
          created_at?: string
          icon_name?: string | null
          id?: string
          label: string
          name: string
          sort_order?: number
        }
        Update: {
          color?: string | null
          created_at?: string
          icon_name?: string | null
          id?: string
          label?: string
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      track_tag_map: {
        Row: {
          created_at: string
          id: string
          tag_id: string | null
          track_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          tag_id?: string | null
          track_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          tag_id?: string | null
          track_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "track_tag_map_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "track_tag_map_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_tag_details"
            referencedColumns: ["tag_id"]
          },
          {
            foreignKeyName: "track_tag_map_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "track_tag_map_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      tracks: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          last_updated: string | null
          order: number | null
          priority: number | null
          track_name: string | null
          track_type: string | null
          updated_at: string | null
          weight: number | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          last_updated?: string | null
          order?: number | null
          priority?: number | null
          track_name?: string | null
          track_type?: string | null
          updated_at?: string | null
          weight?: number | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          last_updated?: string | null
          order?: number | null
          priority?: number | null
          track_name?: string | null
          track_type?: string | null
          updated_at?: string | null
          weight?: number | null
        }
        Relationships: []
      }
      transactions: {
        Row: {
          amount_iqd: number | null
          amount_usd: number | null
          created_at: string | null
          date: string
          exchange_rate: number | null
          from_account_id: string
          id: string
          image_url: string | null
          note: string | null
          to_account_id: string
          type: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          amount_iqd?: number | null
          amount_usd?: number | null
          created_at?: string | null
          date?: string
          exchange_rate?: number | null
          from_account_id: string
          id?: string
          image_url?: string | null
          note?: string | null
          to_account_id: string
          type: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          amount_iqd?: number | null
          amount_usd?: number | null
          created_at?: string | null
          date?: string
          exchange_rate?: number | null
          from_account_id?: string
          id?: string
          image_url?: string | null
          note?: string | null
          to_account_id?: string
          type?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_from_account_id_fkey"
            columns: ["from_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_to_account_id_fkey"
            columns: ["to_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user: {
        Row: {
          allow_connecting_in_app_notifications: boolean
          allow_connecting_push_notifications: boolean
          allow_daily_in_app_notifications: boolean
          allow_daily_push_notifications: boolean
          allow_daily_reminders_notifications: boolean
          auth_provider: string | null
          birth_date: string
          birth_month: number | null
          birth_year: number | null
          chats_in_app_notifications: boolean
          chats_push_notifications: boolean
          comments_in_app_notifications: boolean
          comments_push_notifications: boolean
          created_at: string
          daily_reminder_time: string
          display_name: string | null
          email: string | null
          fcm_token: string | null
          financials: string | null
          gender: string | null
          groups_in_app_notifications: boolean
          groups_push_notifications: boolean
          has_seen_lesson_intro: boolean | null
          has_seen_mlp_intro: boolean | null
          has_seen_questionnaire_intro: boolean | null
          id: string
          image_blur_hash: string | null
          image_url: string | null
          is_verified: boolean
          likes_in_app_notifications: boolean
          likes_push_notifications: boolean
          mentions_in_app_notifications: boolean
          mentions_push_notifications: boolean
          moosies: number
          name: string | null
          onboarding_complete: boolean | null
          parenting_status: string | null
          phone: string | null
          region: string | null
          replies_in_app_notifications: boolean
          replies_push_notifications: boolean
          role: string
          updated_at: string | null
          user_offset: number
        }
        Insert: {
          allow_connecting_in_app_notifications?: boolean
          allow_connecting_push_notifications?: boolean
          allow_daily_in_app_notifications?: boolean
          allow_daily_push_notifications?: boolean
          allow_daily_reminders_notifications?: boolean
          auth_provider?: string | null
          birth_date?: string
          birth_month?: number | null
          birth_year?: number | null
          chats_in_app_notifications?: boolean
          chats_push_notifications?: boolean
          comments_in_app_notifications?: boolean
          comments_push_notifications?: boolean
          created_at?: string
          daily_reminder_time: string
          display_name?: string | null
          email?: string | null
          fcm_token?: string | null
          financials?: string | null
          gender?: string | null
          groups_in_app_notifications?: boolean
          groups_push_notifications?: boolean
          has_seen_lesson_intro?: boolean | null
          has_seen_mlp_intro?: boolean | null
          has_seen_questionnaire_intro?: boolean | null
          id: string
          image_blur_hash?: string | null
          image_url?: string | null
          is_verified?: boolean
          likes_in_app_notifications?: boolean
          likes_push_notifications?: boolean
          mentions_in_app_notifications?: boolean
          mentions_push_notifications?: boolean
          moosies?: number
          name?: string | null
          onboarding_complete?: boolean | null
          parenting_status?: string | null
          phone?: string | null
          region?: string | null
          replies_in_app_notifications?: boolean
          replies_push_notifications?: boolean
          role?: string
          updated_at?: string | null
          user_offset?: number
        }
        Update: {
          allow_connecting_in_app_notifications?: boolean
          allow_connecting_push_notifications?: boolean
          allow_daily_in_app_notifications?: boolean
          allow_daily_push_notifications?: boolean
          allow_daily_reminders_notifications?: boolean
          auth_provider?: string | null
          birth_date?: string
          birth_month?: number | null
          birth_year?: number | null
          chats_in_app_notifications?: boolean
          chats_push_notifications?: boolean
          comments_in_app_notifications?: boolean
          comments_push_notifications?: boolean
          created_at?: string
          daily_reminder_time?: string
          display_name?: string | null
          email?: string | null
          fcm_token?: string | null
          financials?: string | null
          gender?: string | null
          groups_in_app_notifications?: boolean
          groups_push_notifications?: boolean
          has_seen_lesson_intro?: boolean | null
          has_seen_mlp_intro?: boolean | null
          has_seen_questionnaire_intro?: boolean | null
          id?: string
          image_blur_hash?: string | null
          image_url?: string | null
          is_verified?: boolean
          likes_in_app_notifications?: boolean
          likes_push_notifications?: boolean
          mentions_in_app_notifications?: boolean
          mentions_push_notifications?: boolean
          moosies?: number
          name?: string | null
          onboarding_complete?: boolean | null
          parenting_status?: string | null
          phone?: string | null
          region?: string | null
          replies_in_app_notifications?: boolean
          replies_push_notifications?: boolean
          role?: string
          updated_at?: string | null
          user_offset?: number
        }
        Relationships: []
      }
      user_configurations: {
        Row: {
          daily_limit: number
          free_trial_days: number
          mlp_limit: number
          monthly_fee: number
          moosi_to_add: number
          updated_at: string | null
          user_id: string
          yearly_fee: number
        }
        Insert: {
          daily_limit: number
          free_trial_days: number
          mlp_limit: number
          monthly_fee: number
          moosi_to_add: number
          updated_at?: string | null
          user_id: string
          yearly_fee: number
        }
        Update: {
          daily_limit?: number
          free_trial_days?: number
          mlp_limit?: number
          monthly_fee?: number
          moosi_to_add?: number
          updated_at?: string | null
          user_id?: string
          yearly_fee?: number
        }
        Relationships: [
          {
            foreignKeyName: "user_configurations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "user_configurations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_configurations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_demographic_responses: {
        Row: {
          answer_id: string
          answered_at: string
          id: string
          question_id: string
          user_id: string
        }
        Insert: {
          answer_id: string
          answered_at?: string
          id?: string
          question_id: string
          user_id: string
        }
        Update: {
          answer_id?: string
          answered_at?: string
          id?: string
          question_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_demographic_responses_answer_id_fkey"
            columns: ["answer_id"]
            isOneToOne: false
            referencedRelation: "demographic_answers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_demographic_responses_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "demographic_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_demographic_responses_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "user_demographic_responses_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_demographic_responses_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_lesson_progress: {
        Row: {
          created_at: string
          id: string
          is_completed: boolean | null
          lesson_id: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_completed?: boolean | null
          lesson_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_completed?: boolean | null
          lesson_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_lesson_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "user_lesson_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_lesson_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_lesson_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_lesson_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "user_lesson_progress_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "user_lesson_progress_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_lesson_progress_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_mlp: {
        Row: {
          abbreviated_title: string | null
          created_at: string
          item_description: string | null
          item_id: string
          item_name: string
          item_priority: number | null
          item_type: string
          position: number | null
          task_image: string | null
          track_id: string
          track_name: string | null
          track_priority: number | null
          track_weight: number | null
          updated_at: string | null
          user_id: string
          with_quiz: boolean
        }
        Insert: {
          abbreviated_title?: string | null
          created_at?: string
          item_description?: string | null
          item_id: string
          item_name: string
          item_priority?: number | null
          item_type: string
          position?: number | null
          task_image?: string | null
          track_id: string
          track_name?: string | null
          track_priority?: number | null
          track_weight?: number | null
          updated_at?: string | null
          user_id: string
          with_quiz: boolean
        }
        Update: {
          abbreviated_title?: string | null
          created_at?: string
          item_description?: string | null
          item_id?: string
          item_name?: string
          item_priority?: number | null
          item_type?: string
          position?: number | null
          task_image?: string | null
          track_id?: string
          track_name?: string | null
          track_priority?: number | null
          track_weight?: number | null
          updated_at?: string | null
          user_id?: string
          with_quiz?: boolean
        }
        Relationships: []
      }
      user_mlp_bs_backup: {
        Row: {
          abbreviated_title: string | null
          created_at: string | null
          item_description: string | null
          item_id: string | null
          item_name: string | null
          item_priority: number | null
          item_type: string | null
          position: number | null
          task_image: string | null
          track_id: string | null
          track_name: string | null
          track_priority: number | null
          track_weight: number | null
          updated_at: string | null
          user_id: string | null
          with_quiz: boolean | null
        }
        Insert: {
          abbreviated_title?: string | null
          created_at?: string | null
          item_description?: string | null
          item_id?: string | null
          item_name?: string | null
          item_priority?: number | null
          item_type?: string | null
          position?: number | null
          task_image?: string | null
          track_id?: string | null
          track_name?: string | null
          track_priority?: number | null
          track_weight?: number | null
          updated_at?: string | null
          user_id?: string | null
          with_quiz?: boolean | null
        }
        Update: {
          abbreviated_title?: string | null
          created_at?: string | null
          item_description?: string | null
          item_id?: string | null
          item_name?: string | null
          item_priority?: number | null
          item_type?: string | null
          position?: number | null
          task_image?: string | null
          track_id?: string | null
          track_name?: string | null
          track_priority?: number | null
          track_weight?: number | null
          updated_at?: string | null
          user_id?: string | null
          with_quiz?: boolean | null
        }
        Relationships: []
      }
      user_mlp_mods: {
        Row: {
          action: string
          created_at: string
          id: string
          tag_id: string | null
          track_id: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          tag_id?: string | null
          track_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          tag_id?: string | null
          track_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_mlp_mods_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_mlp_mods_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_tag_details"
            referencedColumns: ["tag_id"]
          },
          {
            foreignKeyName: "user_mlp_mods_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_mlp_mods_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
          {
            foreignKeyName: "user_mlp_mods_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "user_mlp_mods_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_mlp_mods_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_mlp_v2: {
        Row: {
          abbreviated_title: string | null
          created_at: string
          item_description: string | null
          item_id: string
          item_name: string
          item_priority: number | null
          item_type: string
          position: number | null
          task_image: string | null
          track_id: string
          track_name: string | null
          track_priority: number | null
          track_weight: number | null
          updated_at: string | null
          user_id: string
          with_quiz: boolean
        }
        Insert: {
          abbreviated_title?: string | null
          created_at?: string
          item_description?: string | null
          item_id: string
          item_name: string
          item_priority?: number | null
          item_type: string
          position?: number | null
          task_image?: string | null
          track_id: string
          track_name?: string | null
          track_priority?: number | null
          track_weight?: number | null
          updated_at?: string | null
          user_id: string
          with_quiz: boolean
        }
        Update: {
          abbreviated_title?: string | null
          created_at?: string
          item_description?: string | null
          item_id?: string
          item_name?: string
          item_priority?: number | null
          item_type?: string
          position?: number | null
          task_image?: string | null
          track_id?: string
          track_name?: string | null
          track_priority?: number | null
          track_weight?: number | null
          updated_at?: string | null
          user_id?: string
          with_quiz?: boolean
        }
        Relationships: []
      }
      user_month_group: {
        Row: {
          created_at: string
          group_id: string
          id: number
          month_index: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          group_id: string
          id?: number
          month_index: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          group_id?: string
          id?: number
          month_index?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_month_group_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_month_group_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups_data"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_month_group_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_month_group_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "user_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      user_questionnaire_progress: {
        Row: {
          complete: boolean | null
          created_at: string
          id: string
          questionnaire_id: string
          questions_answered: number | null
          score: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          complete?: boolean | null
          created_at?: string
          id?: string
          questionnaire_id: string
          questions_answered?: number | null
          score?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          complete?: boolean | null
          created_at?: string
          id?: string
          questionnaire_id?: string
          questions_answered?: number | null
          score?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_questionnaire_progress_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_questionnaire_progress_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire_with_track_name"
            referencedColumns: ["id"]
          },
        ]
      }
      user_segement_track: {
        Row: {
          created_at: string
          id: string
          is_complete: boolean | null
          lesson_id: string | null
          segement_id: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_complete?: boolean | null
          lesson_id?: string | null
          segement_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_complete?: boolean | null
          lesson_id?: string | null
          segement_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          creditor_print_label: string | null
          creditor_receive_label: string | null
          debtor_add_label: string | null
          debtor_print_label: string | null
          fixed_rate_iqd: number | null
          fixed_rate_usd: number | null
          show_compact_view: boolean | null
          updated_at: string | null
          use_fixed_rate: boolean | null
          user_id: string
        }
        Insert: {
          creditor_print_label?: string | null
          creditor_receive_label?: string | null
          debtor_add_label?: string | null
          debtor_print_label?: string | null
          fixed_rate_iqd?: number | null
          fixed_rate_usd?: number | null
          show_compact_view?: boolean | null
          updated_at?: string | null
          use_fixed_rate?: boolean | null
          user_id: string
        }
        Update: {
          creditor_print_label?: string | null
          creditor_receive_label?: string | null
          debtor_add_label?: string | null
          debtor_print_label?: string | null
          fixed_rate_iqd?: number | null
          fixed_rate_usd?: number | null
          show_compact_view?: boolean | null
          updated_at?: string | null
          use_fixed_rate?: boolean | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_tag: {
        Row: {
          added_at: string | null
          id: string
          tag_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          added_at?: string | null
          id?: string
          tag_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          added_at?: string | null
          id?: string
          tag_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_tag_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_tag_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_tag_details"
            referencedColumns: ["tag_id"]
          },
          {
            foreignKeyName: "user_tag_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "user_tag_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_tag_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_tag_actions_MM_unused: {
        Row: {
          action_type: string
          created_at: string
          id: string
          reason: string | null
          source_id: string | null
          source_type: string
          tag_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          action_type: string
          created_at?: string
          id?: string
          reason?: string | null
          source_id?: string | null
          source_type: string
          tag_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          action_type?: string
          created_at?: string
          id?: string
          reason?: string | null
          source_id?: string | null
          source_type?: string
          tag_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_tag_actions_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_tag_actions_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_tag_details"
            referencedColumns: ["tag_id"]
          },
          {
            foreignKeyName: "user_tag_actions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "user_tag_actions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_tag_actions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_template_history: {
        Row: {
          key: string
          last_variant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          key: string
          last_variant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          key?: string
          last_variant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_track_actions_MM_unsed: {
        Row: {
          action_type: string
          created_at: string
          id: string
          reason: string | null
          source_id: string | null
          source_type: string
          track_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          action_type: string
          created_at?: string
          id?: string
          reason?: string | null
          source_id?: string | null
          source_type: string
          track_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          action_type?: string
          created_at?: string
          id?: string
          reason?: string | null
          source_id?: string | null
          source_type?: string
          track_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_track_actions_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_track_actions_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
          {
            foreignKeyName: "user_track_actions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "user_track_actions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_track_actions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_track_activations: {
        Row: {
          confidence: number | null
          created_at: string
          id: string
          source: string
          source_ref: string | null
          track_id: string
          user_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          id?: string
          source: string
          source_ref?: string | null
          track_id: string
          user_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          id?: string
          source?: string
          source_ref?: string | null
          track_id?: string
          user_id?: string
        }
        Relationships: []
      }
      user_track_weights: {
        Row: {
          created_at: string
          id: string
          track_id: string | null
          updated_at: string | null
          user_id: string | null
          weight: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          track_id?: string | null
          updated_at?: string | null
          user_id?: string | null
          weight?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          track_id?: string | null
          updated_at?: string | null
          user_id?: string | null
          weight?: number | null
        }
        Relationships: []
      }
      user_tracks: {
        Row: {
          active: boolean | null
          added_at: string | null
          id: string
          source: string | null
          track_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          active?: boolean | null
          added_at?: string | null
          id?: string
          source?: string | null
          track_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          active?: boolean | null
          added_at?: string | null
          id?: string
          source?: string | null
          track_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_track_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_track_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
          {
            foreignKeyName: "user_track_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "user_track_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_track_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_update_events: {
        Row: {
          child_id: string | null
          correlation_id: string | null
          created_at: string
          distress_tier: string | null
          id: string
          processing_status: string
          raw_text: string
          source: string | null
          user_id: string | null
        }
        Insert: {
          child_id?: string | null
          correlation_id?: string | null
          created_at?: string
          distress_tier?: string | null
          id?: string
          processing_status?: string
          raw_text: string
          source?: string | null
          user_id?: string | null
        }
        Update: {
          child_id?: string | null
          correlation_id?: string | null
          created_at?: string
          distress_tier?: string | null
          id?: string
          processing_status?: string
          raw_text?: string
          source?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      user_update_signals: {
        Row: {
          confidence: number | null
          created_at: string
          event_id: string
          evidence_span: string | null
          id: string
          matched: boolean
          matched_track_id: string | null
          type: string | null
          value: string | null
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          event_id: string
          evidence_span?: string | null
          id?: string
          matched?: boolean
          matched_track_id?: string | null
          type?: string | null
          value?: string | null
        }
        Update: {
          confidence?: number | null
          created_at?: string
          event_id?: string
          evidence_span?: string | null
          id?: string
          matched?: boolean
          matched_track_id?: string | null
          type?: string | null
          value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_update_signals_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "user_update_events"
            referencedColumns: ["id"]
          },
        ]
      }
      users_internal: {
        Row: {
          created_at: string
          id: string
          role: string
          updated_at: string | null
          user_id_auth: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          role: string
          updated_at?: string | null
          user_id_auth?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          role?: string
          updated_at?: string | null
          user_id_auth?: string | null
        }
        Relationships: []
      }
      voice_lint_rules: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          max: number | null
          message: string
          min_words: number | null
          pattern: string | null
          requires: string | null
          rule_key: string
          scope: string | null
          severity: string
          tone: string | null
          type: string
          updated_at: string
          within_chars: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          max?: number | null
          message: string
          min_words?: number | null
          pattern?: string | null
          requires?: string | null
          rule_key: string
          scope?: string | null
          severity: string
          tone?: string | null
          type: string
          updated_at?: string
          within_chars?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          max?: number | null
          message?: string
          min_words?: number | null
          pattern?: string | null
          requires?: string | null
          rule_key?: string
          scope?: string | null
          severity?: string
          tone?: string | null
          type?: string
          updated_at?: string
          within_chars?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      completed_items_streak: {
        Row: {
          max_unique_weekday_streak: number | null
          streak_dates: string[] | null
          user_id: string | null
          weekday_names: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      completed_items_with_tags: {
        Row: {
          completed_item_id: number | null
          item_id: string | null
          item_name: string | null
          item_type: string | null
          tags: string[] | null
          user_id: string | null
          with_quiz: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      friends_with_user_ids: {
        Row: {
          created_at: string | null
          id: string | null
          users_ids: string[] | null
        }
        Insert: {
          created_at?: string | null
          id?: string | null
          users_ids?: never
        }
        Update: {
          created_at?: string | null
          id?: string | null
          users_ids?: never
        }
        Relationships: []
      }
      groups: {
        Row: {
          admin_id: string | null
          allow_all: boolean | null
          children_count: number | null
          created_at: string | null
          created_by: string | null
          description: string | null
          gender: string[] | null
          group_members: Json | null
          group_name: string | null
          id: string | null
          image_blur_hash: string | null
          image_url: string | null
          is_suggested: boolean | null
          marital_status: string[] | null
          members: string[] | null
        }
        Relationships: []
      }
      item_tag_names: {
        Row: {
          item_id: string | null
          tag_name: string | null
        }
        Relationships: []
      }
      lesson_questions: {
        Row: {
          created_at: string | null
          id: string | null
          image_url: string | null
          item_id: string | null
          item_type: string | null
          lesson_id: string | null
          parent_lesson_id: string | null
          parent_segment_id: string | null
          question_explanation: string | null
          question_text: string | null
          segment_id: string | null
          type: string | null
        }
        Relationships: [
          {
            foreignKeyName: "questions_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "questions_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_segment_id"]
          },
          {
            foreignKeyName: "questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "user_segment_progress"
            referencedColumns: ["segment_id"]
          },
          {
            foreignKeyName: "questions_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "v_segment_details"
            referencedColumns: ["id"]
          },
        ]
      }
      lesson_segment_counts_with_track: {
        Row: {
          article: string | null
          created_at: string | null
          description: string | null
          id: string | null
          image_url: string | null
          is_published: boolean | null
          lesson_name: string | null
          max_child_age: number | null
          max_questionnaire_score_range: number | null
          min_child_age: number | null
          min_questionnaire_score_range: number | null
          priority: number | null
          segment_count: number | null
          segment_status: string | null
          status: string | null
          time: number | null
          track_id: string | null
          track_name: string | null
          with_quiz: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "lessons_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lessons_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      lessons_with_track_name: {
        Row: {
          article: string | null
          created_at: string | null
          description: string | null
          id: string | null
          image_url: string | null
          is_published: boolean | null
          lesson_name: string | null
          max_child_age: number | null
          max_questionnaire_score_range: number | null
          min_child_age: number | null
          min_questionnaire_score_range: number | null
          priority: number | null
          segment_status: string | null
          status: string | null
          time: number | null
          track_id: string | null
          track_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lessons_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lessons_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      mlp_item_pool: {
        Row: {
          is_published: boolean | null
          item_description: string | null
          item_id: string | null
          item_name: string | null
          item_type: string | null
          max_child_age: number | null
          min_child_age: number | null
          priority: number | null
          track_id: string | null
          with_quiz: boolean | null
        }
        Relationships: []
      }
      post_comments_count: {
        Row: {
          count: number | null
          post_id: string | null
        }
        Relationships: []
      }
      questionnaire_response_with_track_tag: {
        Row: {
          action_type: string | null
          add: boolean | null
          created_at: string | null
          id: string | null
          item_name: string | null
          item_type: string | null
          questionnaire_id: string | null
          response: string | null
          score_max_range: number | null
          score_min_range: number | null
          tag_id: string | null
          track_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "questionnaire_response_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_tag_details"
            referencedColumns: ["tag_id"]
          },
          {
            foreignKeyName: "questionnaire_response_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      questionnaire_responses_tracks: {
        Row: {
          action_at: string | null
          add: boolean | null
          questionnaire_id: string | null
          response_id: string | null
          score: number | null
          score_max_range: number | null
          score_min_range: number | null
          tag_id: string | null
          track_id: string | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completed_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "questionnaire_response_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_tag_details"
            referencedColumns: ["tag_id"]
          },
          {
            foreignKeyName: "questionnaire_response_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_response_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      questionnaire_user_score: {
        Row: {
          calculated_at: string | null
          questionnaire_id: string | null
          total_score: number | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "questionnaire_user_answers_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_user_answers_questionnaire_id_fkey"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_user_answers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "questionnaire_user_answers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_user_answers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      questionnaire_with_track_name: {
        Row: {
          created_at: string | null
          description: string | null
          id: string | null
          is_published: boolean | null
          is_score_based: boolean | null
          priority: number | null
          questionnaire_name: string | null
          track_id: string | null
          track_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "questionnaire_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questionnaire_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
        ]
      }
      starred_items_with_details: {
        Row: {
          is_completed: boolean | null
          item_description: string | null
          item_id: string | null
          item_name: string | null
          item_type: string | null
          starred_item_id: number | null
          tags: string[] | null
          task_image: string | null
          user_id: string | null
          with_quiz: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "starred_items_user id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "starred_items_user id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "starred_items_user id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      sub_segment_image_fallback: {
        Row: {
          content: string | null
          effective_image_url: string | null
          lesson_id: string | null
          lesson_name: string | null
          seg_id: string | null
          sequence: number | null
          sub_segment_id: string | null
          title: string | null
        }
        Relationships: [
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_segment_id"]
          },
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "user_segment_progress"
            referencedColumns: ["segment_id"]
          },
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "v_segment_details"
            referencedColumns: ["id"]
          },
        ]
      }
      sub_segments_image_fallback: {
        Row: {
          content: string | null
          effective_image_url: string | null
          lesson_id: string | null
          lesson_name: string | null
          seg_id: string | null
          sub_segment_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_segment_id"]
          },
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "user_segment_progress"
            referencedColumns: ["segment_id"]
          },
          {
            foreignKeyName: "sub_segment_seg_id_fkey"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "v_segment_details"
            referencedColumns: ["id"]
          },
        ]
      }
      suggested_groups: {
        Row: {
          admin_id: string | null
          allow_all: boolean | null
          child_count: number | null
          children_count: number | null
          created_at: string | null
          created_by: string | null
          description: string | null
          gender: string[] | null
          group_name: string | null
          id: string | null
          image_blur_hash: string | null
          image_url: string | null
          is_suggested: boolean | null
          marital_status: string[] | null
          members: string[] | null
          user_gender: string | null
          user_id: string | null
          user_parenting_status: string | null
        }
        Relationships: []
      }
      track_priorities: {
        Row: {
          item_type: string | null
          lesson_id: string | null
          name: string | null
          priority: number | null
          questionnaire_id: string | null
          track_id: string | null
        }
        Relationships: []
      }
      unique_items_today_by_user: {
        Row: {
          id: string | null
          is_exceeded: boolean | null
          unique_items: string[] | null
          unique_lesson_count: number | null
          user_id: string | null
        }
        Relationships: []
      }
      user_active_tracks: {
        Row: {
          priority: number | null
          track_id: string | null
          track_name: string | null
          user_id: string | null
          weight: number | null
        }
        Relationships: []
      }
      user_active_tracks_with_reason: {
        Row: {
          active_reason: string | null
          manual_action_at: string | null
          manual_mod_id: string | null
          priority: number | null
          questionnaire_action_at: string | null
          questionnaire_id: string | null
          questionnaire_rule_id: string | null
          questionnaire_score: number | null
          questionnaire_source: string | null
          questionnaire_tag_id: string | null
          reason_detail: string | null
          track_id: string | null
          track_name: string | null
          user_id: string | null
          weight: number | null
        }
        Relationships: []
      }
      user_feed_posts: {
        Row: {
          created_at: string | null
          created_by: string | null
          deleted: boolean | null
          group_id: string | null
          id: string | null
          image_blur_hash: string[] | null
          image_url: string[] | null
          is_feed: boolean | null
          likes: string[] | null
          post_text: string | null
          viewer_id: string | null
        }
        Relationships: []
      }
      user_groups: {
        Row: {
          admin_id: string | null
          allow_all: boolean | null
          children_count: number | null
          created_at: string | null
          created_by: string | null
          description: string | null
          gender: string[] | null
          group_members: Json | null
          group_name: string | null
          id: string | null
          image_blur_hash: string | null
          image_url: string | null
          is_suggested: boolean | null
          marital_status: string[] | null
          member_role: string | null
          member_user_id: string | null
          members: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "group_member_user_id_fkey"
            columns: ["member_user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "group_member_user_id_fkey"
            columns: ["member_user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_member_user_id_fkey"
            columns: ["member_user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_mlp_data: {
        Row: {
          child_count: number | null
          financials: string | null
          gender: string | null
          parenting_status: string | null
          user_id: string | null
          youngest_age_in_months: number | null
        }
        Relationships: []
      }
      user_mlp_not_completed: {
        Row: {
          abbreviated_title: string | null
          created_at: string | null
          item_description: string | null
          item_id: string | null
          item_name: string | null
          item_priority: number | null
          item_type: string | null
          position: number | null
          rn: number | null
          task_image: string | null
          topic_color: string | null
          topic_id: string | null
          topic_label: string | null
          track_id: string | null
          track_name: string | null
          track_priority: number | null
          track_weight: number | null
          user_id: string | null
          with_quiz: boolean | null
        }
        Relationships: []
      }
      user_mlp_not_completed_limited: {
        Row: {
          created_at: string | null
          item_description: string | null
          item_id: string | null
          item_name: string | null
          item_priority: number | null
          item_type: string | null
          mlp_limit: number | null
          position: number | null
          rn: number | null
          track_id: string | null
          track_name: string | null
          track_priority: number | null
          track_weight: number | null
          user_id: string | null
          with_quiz: boolean | null
        }
        Relationships: []
      }
      user_segment_progress: {
        Row: {
          completed_at: string | null
          description: string | null
          image_url: string | null
          is_complete: boolean | null
          lesson_id: string | null
          segment_id: string | null
          segment_order: number | null
          title: string | null
          total_sub_segments: number | null
        }
        Relationships: [
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
        ]
      }
      user_track_details: {
        Row: {
          active: boolean | null
          added_at: string | null
          description: string | null
          priority: number | null
          source: string | null
          track_id: string | null
          track_name: string | null
          user_id: string | null
          user_track_id: string | null
          weight: number | null
        }
        Relationships: [
          {
            foreignKeyName: "user_track_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_track_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["track_id"]
          },
          {
            foreignKeyName: "user_track_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "suggested_groups"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "user_track_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_track_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_mlp_data"
            referencedColumns: ["user_id"]
          },
        ]
      }
      v_lesson_details: {
        Row: {
          description: string | null
          image_url: string | null
          is_published: boolean | null
          lesson_id: string | null
          lesson_name: string | null
          max_child_age: number | null
          min_child_age: number | null
          status: string | null
          tags: string | null
          time: number | null
          track_id: string | null
          track_name: string | null
        }
        Relationships: []
      }
      v_lesson_tag_details: {
        Row: {
          last_updated: string | null
          lesson_id: string | null
          tag_description: string | null
          tag_id: string | null
          tag_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lesson_tags_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "lesson_tags_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_tags_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_tags_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_tags_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
        ]
      }
      v_segment_details: {
        Row: {
          anchor_text: string | null
          content: string | null
          created_at: string | null
          description: string | null
          full_prompt: string | null
          id: string | null
          image_prompt: string | null
          Image_url: string | null
          lesson_description: string | null
          lesson_id: string | null
          lesson_name: string | null
          min_child_age: number | null
          question_id: number | null
          ref_link: string | null
          seg_status: string | null
          segment_name: string | null
          segment_order: number | null
          takeaway: string | null
          title: string | null
          tone: string | null
          video_url: string | null
        }
        Relationships: [
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_questions"
            referencedColumns: ["parent_lesson_id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lesson_segment_counts_with_track"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons_with_track_name"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "v_lesson_details"
            referencedColumns: ["lesson_id"]
          },
        ]
      }
    }
    Functions: {
      apply_classification: {
        Args: {
          p_child_id: string
          p_event_id: string
          p_milestones: Json
          p_proposals: Json
          p_user_id: string
        }
        Returns: Json
      }
      approve_content_image:
        | {
            Args: { p_approved_by: string; p_id: string; p_public_url: string }
            Returns: Json
          }
        | {
            Args: {
              p_approved_by: string
              p_id: string
              p_public_url: string
              p_storage_path: string
            }
            Returns: Json
          }
      approve_segment_bundle: {
        Args: { p_approved_by: string; p_images: Json; p_seg_id: string }
        Returns: Json
      }
      create_lessons_with_segments: {
        Args: { p_lessons: Json }
        Returns: {
          description: string
          id: string
          lesson_name: string
        }[]
      }
      is_admin: { Args: never; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
      rebuild_user_mlp: {
        Args: { p_items: Json; p_user_id: string }
        Returns: number
      }
      renumber_track_priorities: {
        Args: { p_ordered_ids: string[]; p_track_id: string }
        Returns: undefined
      }
      renumber_track_priority_order: {
        Args: { p_ordered_ids: string[] }
        Returns: undefined
      }
      unapprove_segment_bundle: { Args: { p_seg_id: string }; Returns: Json }
      user_active_tracks_for_user: {
        Args: { p_user_id: string }
        Returns: {
          priority: number
          track_id: string
          track_name: string
          user_id: string
          weight: number
        }[]
      }
    }
    Enums: {
      account_type:
        | "cash_accounts"
        | "capital"
        | "expenses"
        | "customers"
        | "suppliers"
        | "due_invoices"
      role: "user" | "admin" | "super"
      subscription_status: "active" | "expired" | "cancelled" | "trial"
      transaction_type:
        | "debt_given"
        | "debt_repayment"
        | "expense"
        | "income"
        | "transfer"
        | "currency_exchange"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_type: [
        "cash_accounts",
        "capital",
        "expenses",
        "customers",
        "suppliers",
        "due_invoices",
      ],
      role: ["user", "admin", "super"],
      subscription_status: ["active", "expired", "cancelled", "trial"],
      transaction_type: [
        "debt_given",
        "debt_repayment",
        "expense",
        "income",
        "transfer",
        "currency_exchange",
      ],
    },
  },
} as const
