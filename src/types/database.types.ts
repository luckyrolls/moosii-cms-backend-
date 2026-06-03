export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
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
            foreignKeyName: "fk_account_types_user_id"
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
            foreignKeyName: "fk_accounts_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_accounts_type_id"
            columns: ["type_id"]
            isOneToOne: false
            referencedRelation: "account_types"
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
          id: number
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
            foreignKeyName: "fk_age_track_weights_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "fk_answers_legacy_question_id"
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
          id: number
          item_description?: string
          item_id?: string | null
          item_name?: string
          item_type?: string | null
          lesson_id?: string | null
          questionnaire_id?: string | null
          score: number
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
            foreignKeyName: "fk_completed_items_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_completed_items_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_completed_items_questionnaire_id"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
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
          free_trial_days: number
          id: number
          mlp_limit?: number | null
          monthly_fee: number
          moosi_to_add: number
          updated_at?: string | null
          weight_factor?: number | null
          yearly_fee: number
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
          segment_id?: string | null
          status?: string
          storage_path: string
          sub_segment_id?: string | null
          tags: string[]
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
          segment_id?: string | null
          status?: string
          storage_path?: string
          sub_segment_id?: string | null
          tags?: string[]
          topic_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_content_images_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_content_images_segment_id"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_content_images_sub_segment_id"
            columns: ["sub_segment_id"]
            isOneToOne: false
            referencedRelation: "sub_segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_content_images_job_id"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "fk_friends_user_a"
            columns: ["user_a"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_friends_user_b"
            columns: ["user_b"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
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
          id: number
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
            foreignKeyName: "fk_group_member_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_group_member_group_id"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups_data"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_group_message_group_chat_id"
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
          input: Json
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
            foreignKeyName: "fk_lesson_tags_tag_id"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_lesson_tags_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
        ]
      }
      lessons: {
        Row: {
          abbreviated_title: string
          article: string | null
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
            foreignKeyName: "fk_lessons_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_lessons_topic_id"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_message_chat_id"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "chat"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "fk_new_user_tracks_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
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
          id: number
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
            foreignKeyName: "fk_notification_log_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_notifications_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
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
          id: number
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
            foreignKeyName: "fk_payment_history_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_payment_history_plan_id"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
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
            foreignKeyName: "fk_posts_created_by"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
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
          subscription_status: string | null
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
          subscription_status?: string | null
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
          subscription_status?: string | null
          updated_at?: string | null
          username?: string
        }
        Relationships: []
      }
      prompts: {
        Row: {
          created_at: string
          default: boolean | null
          id: string
          prompt: string | null
          prompt_type: string | null
          tone: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string
          default?: boolean | null
          id?: string
          prompt?: string | null
          prompt_type?: string | null
          tone?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string
          default?: boolean | null
          id?: string
          prompt?: string | null
          prompt_type?: string | null
          tone?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      questionnaire: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_published: boolean | null
          is_score_based: boolean | null
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
          created_at?: string
          description?: string | null
          id?: string
          is_published?: boolean | null
          is_score_based?: boolean | null
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
          created_at?: string
          description?: string | null
          id?: string
          is_published?: boolean | null
          is_score_based?: boolean | null
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
            foreignKeyName: "fk_questionnaire_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_topic_id"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_questionnaire_answers_question_id"
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
            foreignKeyName: "fk_questionnaire_questions_questionnaire_id"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
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
          response?: string | null
          score_max_range?: number | null
          score_min_range?: number | null
          tag_id?: string | null
          track_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_questionnaire_response_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_response_questionnaire_id"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_response_tag_id"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_questionnaire_user_answers_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_user_answers_questionnaire_id"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_user_answers_question_id"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions_legacy"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_user_answers_answer_id"
            columns: ["answer_id"]
            isOneToOne: false
            referencedRelation: "answers_legacy"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_questions_legacy_segment_id"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questions_legacy_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
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
            foreignKeyName: "fk_quiz_answers_question_id"
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
            foreignKeyName: "fk_quiz_questions_segment_id"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
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
            foreignKeyName: "fk_quiz_response_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_quiz_response_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_quiz_user_progress_question_id"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "quiz_questions"
            referencedColumns: ["question_id"]
          },
          {
            foreignKeyName: "fk_quiz_user_progress_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_recurring_invoices_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_recurring_invoices_from_account_id"
            columns: ["from_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_recurring_invoices_to_account_id"
            columns: ["to_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
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
            foreignKeyName: "fk_segments_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
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
        }
        Relationships: [
          {
            foreignKeyName: "fk_sub_segments_seg_id"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "segments"
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
            foreignKeyName: "fk_tag_item_map_tag_id"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
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
          id: number
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
            foreignKeyName: "fk_track_tag_map_tag_id"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_track_tag_map_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      tracks: {
        Row: {
          co_parenting_status: string[] | null
          created_at: string
          description: string | null
          financial_status: string[] | null
          id: string
          last_updated: string | null
          order: number | null
          priority: number | null
          promote_higher: boolean
          track_name: string | null
          track_type: string | null
          updated_at: string | null
          user_gender: string[] | null
          weight: number | null
        }
        Insert: {
          co_parenting_status?: string[] | null
          created_at?: string
          description?: string | null
          financial_status?: string[] | null
          id?: string
          last_updated?: string | null
          order?: number | null
          priority?: number | null
          promote_higher?: boolean
          track_name?: string | null
          track_type?: string | null
          updated_at?: string | null
          user_gender?: string[] | null
          weight?: number | null
        }
        Update: {
          co_parenting_status?: string[] | null
          created_at?: string
          description?: string | null
          financial_status?: string[] | null
          id?: string
          last_updated?: string | null
          order?: number | null
          priority?: number | null
          promote_higher?: boolean
          track_name?: string | null
          track_type?: string | null
          updated_at?: string | null
          user_gender?: string[] | null
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
            foreignKeyName: "fk_transactions_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_transactions_from_account_id"
            columns: ["from_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_transactions_to_account_id"
            columns: ["to_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
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
          moosies: number
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
            foreignKeyName: "fk_user_configurations_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_user_lesson_progress_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_user_lesson_progress_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "fk_user_mlp_mods_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_user_mlp_mods_tag_id"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_user_mlp_mods_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
        ]
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
          id: number
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
            foreignKeyName: "fk_user_month_group_group_id"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups_data"
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
            foreignKeyName: "fk_user_questionnaire_progress_questionnaire_id"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
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
            foreignKeyName: "fk_user_settings_user_id"
            columns: ["user_id"]
            isOneToOne: false
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
            foreignKeyName: "fk_user_tag_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_user_tag_tag_id"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_user_tag_actions_MM_unused_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_user_tag_actions_MM_unused_tag_id"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "fk_user_track_actions_MM_unsed_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_user_track_actions_MM_unsed_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "fk_user_tracks_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_user_tracks_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
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
            foreignKeyName: "fk_completed_items_streak_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_completed_items_with_tags_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
        ]
      }
      friends_with_user_ids: {
        Row: {
          created_at: string | null
          id: string | null
          users_ids: string[] | null
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
            foreignKeyName: "fk_lesson_questions_segment_id"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_lesson_questions_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
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
            foreignKeyName: "fk_lesson_segment_counts_with_track_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_lessons_with_track_name_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_questionnaire_response_with_track_tag_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_response_with_track_tag_questionnaire_id"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_response_with_track_tag_tag_id"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_questionnaire_responses_tracks_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_responses_tracks_questionnaire_id"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_responses_tracks_tag_id"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_responses_tracks_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_questionnaire_user_score_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_questionnaire_user_score_questionnaire_id"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_questionnaire_with_track_name_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      starred_items: {
        Row: {
          id: number | null
          item_id: string
          lesson_id: string | null
          questionnaire_id: string | null
          updated_at: string | null
          "user id": string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_starred_items_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_starred_items_questionnaire_id"
            columns: ["questionnaire_id"]
            isOneToOne: false
            referencedRelation: "questionnaire"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_starred_items_with_details_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_sub_segment_image_fallback_seg_id"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_sub_segment_image_fallback_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
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
            foreignKeyName: "fk_sub_segments_image_fallback_seg_id"
            columns: ["seg_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_sub_segments_image_fallback_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
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
            foreignKeyName: "fk_user_groups_member_user_id"
            columns: ["member_user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
        ]
      }
      user_mlp: {
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
        Relationships: []
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
            foreignKeyName: "fk_user_segment_progress_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
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
            foreignKeyName: "fk_user_track_details_user_id"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_user_track_details_track_id"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      user_track_matches: {
        Row: {
          description: string | null
          priority: number | null
          promote_higher: boolean | null
          track_id: string | null
          track_name: string | null
          track_type: string | null
          user_id: string | null
        }
        Relationships: []
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
            foreignKeyName: "fk_v_lesson_tag_details_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
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
          Image_url: string | null
          image_prompt: string | null
          lesson_description: string | null
          lesson_id: string | null
          lesson_name: string | null
          max_child_age: number | null
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
            foreignKeyName: "fk_v_segment_details_lesson_id"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: { [_ in never]: never }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

type DefaultSchema = Database[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
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
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
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
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
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
    | { schema: keyof Database },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never
